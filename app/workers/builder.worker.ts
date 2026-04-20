/// <reference lib="webworker" />
import * as Comlink from "comlink";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { OcrResult, OcrWord } from "~/lib/providers/types";

export interface BuilderPageInput {
  composedPngBytes: ArrayBuffer;
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

      // Embed the MRC composed image as the page background.
      const image = await doc.embedPng(new Uint8Array(pageInput.composedPngBytes));
      page.drawImage(image, { x: 0, y: 0, width: pageW, height: pageH });

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
