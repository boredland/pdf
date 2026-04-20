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
import type { OcrResult, OcrWord } from "~/lib/providers/types";

export interface BuilderPageInput {
  /** Bitonal mask PNG (black text on white). Becomes the foreground text layer. */
  maskPngBytes: ArrayBuffer;
  /** Lossy background layer (JPEG/PNG at reduced resolution). */
  bgBytes: ArrayBuffer;
  /** MIME type for bgBytes — "image/jpeg" or "image/png". */
  bgMimeType: string;
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

      // MRC assembly: lossy background first, then a PDF native /ImageMask
      // XObject on top. The mask is 1 bit per pixel (packed) + flate —
      // typically 5-10× smaller than the 32-bit RGBA alpha-PNG it replaces.
      const bgBytes = new Uint8Array(pageInput.bgBytes);
      const bgImage =
        pageInput.bgMimeType === "image/jpeg"
          ? await doc.embedJpg(bgBytes)
          : await doc.embedPng(bgBytes);
      page.drawImage(bgImage, { x: 0, y: 0, width: pageW, height: pageH });

      await drawMaskAsImageMask(
        doc,
        page,
        new Uint8Array(pageInput.maskPngBytes),
        pageW,
        pageH,
      );

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
 * Draw a bitonal mask onto a page as a PDF native /ImageMask XObject.
 *
 * The mask is stored as 1 bit per pixel (MSB-first, row padded to byte)
 * with /FlateDecode compression. In PDF semantics a 0 bit paints with the
 * current non-stroking fill colour; a 1 bit is transparent. We set fill
 * to pure black (grayscale 0) so mask pixels render as the scan's text.
 *
 * Replaces the previous "alpha PNG over bg" approach, which embedded a
 * 32-bpp RGBA stream — ~8× larger on the same content.
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

  // Pack into 1 bit per pixel, MSB-first, row-padded to byte.
  const bytesPerRow = Math.ceil(widthPx / 8);
  const packed = new Uint8Array(bytesPerRow * heightPx);
  for (let y = 0; y < heightPx; y++) {
    const rowOffset = y * bytesPerRow;
    for (let x = 0; x < widthPx; x++) {
      const lum = data[(y * widthPx + x) * 4]!;
      // 0 = paint (text), 1 = transparent (background).
      if (lum >= 128) {
        packed[rowOffset + (x >> 3)]! |= 1 << (7 - (x & 7));
      }
    }
  }

  // Flate via CompressionStream (available in modern workers).
  const deflated = await compressDeflate(packed);

  // Build the XObject dict. PDFContext.obj() accepts a plain object and
  // wraps values in the right PDF primitives.
  const dict = doc.context.obj({
    Type: "XObject",
    Subtype: "Image",
    Width: widthPx,
    Height: heightPx,
    BitsPerComponent: 1,
    ImageMask: true,
    Filter: "FlateDecode",
    Length: deflated.byteLength,
  });
  const stream = PDFRawStream.of(dict, deflated);
  const ref = doc.context.register(stream);

  // Register XObject in page resources; the returned name is what the
  // content stream references via `/Name Do`.
  const name = page.node.newXObject("Mask", ref);

  // Emit: save state, set fill = black, translate/scale to page size,
  // draw the mask XObject, restore.
  page.pushOperators(
    pushGraphicsState(),
    setFillingGrayscaleColor(0),
    translate(0, 0),
    scale(pageWidthPt, pageHeightPt),
    drawObject(name),
    popGraphicsState(),
  );
}

async function compressDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CS = (self as any).CompressionStream as
    | (new (format: string) => {
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
      })
    | undefined;
  if (!CS) throw new Error("CompressionStream not available");
  const cs = new CS("deflate");
  const writer = cs.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const totalLen = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
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
