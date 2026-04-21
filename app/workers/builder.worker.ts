/// <reference lib="webworker" />
import * as Comlink from "comlink";
import {
  PDFDocument,
  PDFRawStream,
  StandardFonts,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  scale,
  setFillingGrayscaleColor,
  translate,
} from "pdf-lib";
import { encodeJbig2 } from "~/lib/compression/jbig2";
import { encodeCcittG4 } from "~/lib/compression/ccitt-g4";
import type { OcrResult, OcrWord } from "~/lib/providers/types";

export interface BuilderPageInput {
  /** Bitonal mask PNG (black text on white). Becomes the foreground text layer. */
  maskPngBytes: ArrayBuffer;
  /** Lossy background layer (JPEG/PNG at reduced resolution). */
  bgBytes: ArrayBuffer;
  /** MIME type for bgBytes — "image/jpeg" or "image/png". */
  bgMimeType: string;
  /** When true, skip the mask overlay (photo-dominated or blank page). */
  skipMask?: boolean;
  ocr: OcrResult;
  /** Physical page size in points (PDF default is 72dpi). */
  pageWidthPt: number;
  pageHeightPt: number;
}

export interface BuilderInput {
  projectName: string;
  pages: BuilderPageInput[];
}

export interface BuilderOutput {
  pdfBytes: ArrayBuffer;
  /** `true` if the JBIG2 WASM encoder was used for masks (vs CCITT G4 fallback). */
  usedJbig2?: boolean;
}

const api = {
  async build(input: BuilderInput): Promise<BuilderOutput> {
    const doc = await PDFDocument.create();
    doc.setTitle(input.projectName);
    doc.setCreator("pdf — client-side OCR");
    doc.setProducer("pdf-lib + tesseract.js");

    const font = await doc.embedFont(StandardFonts.Helvetica);
    let usedJbig2Global = false;

    for (const pageInput of input.pages) {
      const { pageWidthPt: pageW, pageHeightPt: pageH } = pageInput;
      const page = doc.addPage([pageW, pageH]);

      // MRC assembly: lossy JPEG/PNG background first, then a PDF native
      // /ImageMask XObject on top encoded with CCITT Group 4.
      const bgBytes = new Uint8Array(pageInput.bgBytes);
      const bgImage =
        pageInput.bgMimeType === "image/jpeg"
          ? await doc.embedJpg(bgBytes)
          : await doc.embedPng(bgBytes);
      page.drawImage(bgImage, { x: 0, y: 0, width: pageW, height: pageH });

      // Skip the mask overlay for blank or photo-dominated pages — the
      // MRC split flagged this upstream and the bg alone is a faithful
      // representation. Saves the per-page mask bytes.
      if (!pageInput.skipMask) {
        const didJbig2 = await drawMaskAsImageMask(
          doc,
          page,
          new Uint8Array(pageInput.maskPngBytes),
          pageW,
          pageH,
        );
        if (didJbig2) usedJbig2Global = true;
      }

      // Overlay invisible OCR words. opacity:0 renders the text into the
      // content stream (so PDF viewers extract it) without painting pixels.
      const sxPerPx = pageW / pageInput.ocr.pageSize.width;
      const syPerPx = pageH / pageInput.ocr.pageSize.height;
      for (const word of pageInput.ocr.words) {
        if (!word.text.trim()) continue;
        drawInvisibleWord(page, font, word, sxPerPx, syPerPx, pageH);
      }
    }

    const bytes = await doc.save();
    const transferable = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(transferable).set(bytes);
    return Comlink.transfer(
      { pdfBytes: transferable, usedJbig2: usedJbig2Global },
      [transferable],
    );
  },
};

/**
 * Draw a bitonal mask onto a page as a PDF /ImageMask XObject.
 *
 * Primary path: JBIG2 generic-region encoding (85 KB vendored WASM,
 * ~2-5× tighter than CCITT G4 on text-heavy pages).
 * Fallback: CCITT Group 4 (pure JS) if the WASM fails to load.
 *
 * PDF convention: in the decoded output, 0 = paint with current fill,
 * 1 = transparent. For JBIG2, 0 = white / 1 = black in standard
 * convention, which inverts the ImageMask sense. We therefore set
 * /Decode [1 0] in the XObject dict to flip the interpretation so
 * text pixels (JBIG2 black = 1) paint and background (white = 0) is
 * transparent.
 */
async function drawMaskAsImageMask(
  doc: PDFDocument,
  page: ReturnType<PDFDocument["addPage"]>,
  maskPng: Uint8Array,
  pageWidthPt: number,
  pageHeightPt: number,
): Promise<boolean> {
  const blob = new Blob([maskPng.slice().buffer], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  const widthPx = bitmap.width;
  const heightPx = bitmap.height;

  const canvas = new OffscreenCanvas(widthPx, heightPx);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d ctx unavailable");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const { data } = ctx.getImageData(0, 0, widthPx, heightPx);

  // Pack into MSB-first 1-bit-per-pixel: 1 = black (text), 0 = white (bg).
  const bytesPerRow = Math.ceil(widthPx / 8);
  const packed = new Uint8Array(bytesPerRow * heightPx);
  for (let y = 0; y < heightPx; y++) {
    const rowOffset = y * bytesPerRow;
    for (let x = 0; x < widthPx; x++) {
      const lum = data[(y * widthPx + x) * 4]!;
      if (lum < 128) {
        // text pixel → bit = 1
        packed[rowOffset + (x >> 3)]! |= 1 << (7 - (x & 7));
      }
    }
  }

  // Try JBIG2 first; fall back to CCITT G4 if the WASM can't load.
  let encoded: Uint8Array;
  let useJbig2 = false;
  try {
    encoded = await encodeJbig2(packed, widthPx, heightPx);
    useJbig2 = true;
  } catch {
    // JBIG2 WASM failed — fall back to CCITT G4 (pure JS, always works).
    // CCITT convention: 0=white, 1=black — same bit layout as our packed.
    // But for ImageMask: 0=paint, 1=transparent. So we need inverted bits.
    const ccittPixels = new Uint8Array(widthPx * heightPx);
    for (let i = 0, j = 0; j < ccittPixels.length; i += 4, j++) {
      ccittPixels[j] = (data[i] ?? 0) < 128 ? 1 : 0;
    }
    encoded = encodeCcittG4({
      pixels: ccittPixels,
      width: widthPx,
      height: heightPx,
    });
  }

  let dict;
  if (useJbig2) {
    dict = doc.context.obj({
      Type: "XObject",
      Subtype: "Image",
      Width: widthPx,
      Height: heightPx,
      BitsPerComponent: 1,
      ImageMask: true,
      Filter: "JBIG2Decode",
      // /Decode [1 0] flips the bit interpretation: JBIG2's 1 (black)
      // becomes "paint" in ImageMask, and 0 (white) becomes transparent.
      Decode: [1, 0],
      Length: encoded.byteLength,
    });
  } else {
    const decodeParms = doc.context.obj({
      K: -1,
      Columns: widthPx,
      Rows: heightPx,
      EndOfBlock: true,
    });
    dict = doc.context.obj({
      Type: "XObject",
      Subtype: "Image",
      Width: widthPx,
      Height: heightPx,
      BitsPerComponent: 1,
      ImageMask: true,
      Filter: "CCITTFaxDecode",
      DecodeParms: decodeParms,
      Length: encoded.byteLength,
    });
  }

  const stream = PDFRawStream.of(dict, encoded);
  const ref = doc.context.register(stream);
  const name = page.node.newXObject("Mask", ref);

  page.pushOperators(
    pushGraphicsState(),
    setFillingGrayscaleColor(0),
    translate(0, 0),
    scale(pageWidthPt, pageHeightPt),
    drawObject(name),
    popGraphicsState(),
  );
  return useJbig2;
}


function drawInvisibleWord(
  page: ReturnType<PDFDocument["addPage"]>,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  word: OcrWord,
  sxPerPx: number,
  syPerPx: number,
  pageH: number,
) {
  const textWidthPt = word.bbox.width * sxPerPx;
  const textHeightPt = word.bbox.height * syPerPx;
  // Font size: aim for the glyph height ≈ 0.85 × bbox height. Fonts are a
  // bit taller than their x-height so this keeps invisible text from wildly
  // overshooting its bbox when PDF viewers highlight the selection.
  let fontSize = Math.max(1, textHeightPt * 0.85);

  const measured = font.widthOfTextAtSize(word.text, fontSize);
  if (measured > textWidthPt && measured > 0) {
    fontSize = fontSize * (textWidthPt / measured);
  }

  // Convert image coords (top-left origin, y down) to PDF coords (bottom-left,
  // y up). Bottom of bbox in PDF = pageH - (top + height) × syPerPx.
  const pdfX = word.bbox.x * sxPerPx;
  const pdfY = pageH - (word.bbox.y + word.bbox.height) * syPerPx;

  page.drawText(word.text, {
    x: pdfX,
    y: pdfY,
    size: fontSize,
    font,
    opacity: 0,
  });
}

export type BuilderWorkerApi = typeof api;

Comlink.expose(api);
