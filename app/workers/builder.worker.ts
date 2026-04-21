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
}

const api = {
  async build(input: BuilderInput): Promise<BuilderOutput> {
    const doc = await PDFDocument.create();
    doc.setTitle(input.projectName);
    doc.setCreator("pdf — client-side OCR");
    doc.setProducer("pdf-lib + tesseract.js");

    const font = await doc.embedFont(StandardFonts.Helvetica);

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
        await drawMaskAsImageMask(
          doc,
          page,
          new Uint8Array(pageInput.maskPngBytes),
          pageW,
          pageH,
        );
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
    return Comlink.transfer({ pdfBytes: transferable }, [transferable]);
  },
};

/**
 * Draw a bitonal mask onto a page as a PDF native /ImageMask XObject
 * encoded with CCITT Group 4 (T.6) fax compression.
 *
 * On text-heavy pages T.6 typically emits ~5-10× smaller streams than
 * flate-compressed 1-bit data. The filter is a PDF standard
 * (`/CCITTFaxDecode` with `/K -1`) so every viewer can open it.
 *
 * PDF convention: in CCITT output, 0 is white and 1 is black. ImageMask
 * semantics are 0 = paint with current fill, 1 = transparent — i.e.
 * painted text pixels should be 0 in our CCITT bits. We therefore
 * invert the luminance comparison before packing.
 */
async function drawMaskAsImageMask(
  doc: PDFDocument,
  page: ReturnType<PDFDocument["addPage"]>,
  maskPng: Uint8Array,
  pageWidthPt: number,
  pageHeightPt: number,
) {
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

  // CCITT convention: 1 byte per pixel, 0=white (bg), 1=black (text).
  // In ImageMask semantics: 0 = paint, 1 = transparent. Text pixels
  // (those that should be painted black) therefore need to emerge as 0
  // from the CCITT decoder, so we set them to 0 in the input too.
  const pixels = new Uint8Array(widthPx * heightPx);
  for (let i = 0, j = 0; j < pixels.length; i += 4, j++) {
    pixels[j] = (data[i] ?? 0) < 128 ? 1 : 0;
  }

  const encoded = encodeCcittG4({ pixels, width: widthPx, height: heightPx });

  // DecodeParms for CCITTFaxDecode: K=-1 (Group 4), Columns=width,
  // Rows=height, EndOfBlock=true (we emit the EOFB marker).
  const decodeParms = doc.context.obj({
    K: -1,
    Columns: widthPx,
    Rows: heightPx,
    EndOfBlock: true,
  });
  const dict = doc.context.obj({
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
