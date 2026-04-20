/// <reference lib="webworker" />
import * as Comlink from "comlink";
import { PDFDocument, StandardFonts } from "pdf-lib";
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

      // MRC assembly: embed the lossy background layer first, then the
      // bitonal mask (white pixels made transparent) on top. Viewers
      // composite them into the familiar DjVu-style scan.
      const bgBytes = new Uint8Array(pageInput.bgBytes);
      const bgImage =
        pageInput.bgMimeType === "image/jpeg"
          ? await doc.embedJpg(bgBytes)
          : await doc.embedPng(bgBytes);
      page.drawImage(bgImage, { x: 0, y: 0, width: pageW, height: pageH });

      const transparentMask = await maskToTransparentPng(
        new Uint8Array(pageInput.maskPngBytes),
      );
      const maskImage = await doc.embedPng(transparentMask);
      page.drawImage(maskImage, { x: 0, y: 0, width: pageW, height: pageH });

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
 * Convert a bitonal black-on-white mask PNG into a PNG with transparent
 * white pixels, so it composites cleanly over the background layer.
 * The mask's pixels vote by luminance: brighter than the threshold → alpha 0,
 * darker → fully opaque black. This is the simplest MRC composite mode
 * that pdf-lib can express without dropping to PDFDict internals.
 */
async function maskToTransparentPng(maskPng: Uint8Array): Promise<Uint8Array> {
  const blob = new Blob([maskPng.slice().buffer], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d ctx unavailable");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const lum = data[i]!; // mask is grayscale, R=G=B
    if (lum >= 128) {
      // background / non-text pixel → make fully transparent.
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 0;
    } else {
      // text pixel → fully opaque black.
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await outBlob.arrayBuffer());
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
