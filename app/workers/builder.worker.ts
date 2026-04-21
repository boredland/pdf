/// <reference lib="webworker" />
import * as Comlink from "comlink";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { OcrResult, OcrWord } from "~/lib/providers/types";

/** Per-page OCR data needed for the overlay. */
export interface OverlayPageInput {
  ocr: OcrResult;
  /** Physical page size in points (72 DPI base). */
  pageWidthPt: number;
  pageHeightPt: number;
}

export interface BuilderInput {
  projectName: string;
  /** The original source PDF bytes — we'll load it and add text on top. */
  sourcePdfBytes: ArrayBuffer;
  /** One entry per page that has OCR output. Pages without OCR are left as-is. */
  pages: OverlayPageInput[];
  /** Sparse map: pageIndex → OverlayPageInput index in `pages`. */
  pageIndexMap: number[];
}

export interface BuilderOutput {
  pdfBytes: ArrayBuffer;
}

const api = {
  /**
   * Overlay invisible OCR text onto the **original** source PDF. This
   * preserves the source's native image encoding (JPEG, CCITT, whatever
   * the scanner wrote) so the output is source-size + a few KB of text.
   * No re-encoding, no quality loss, no compression regression.
   */
  async build(input: BuilderInput): Promise<BuilderOutput> {
    const doc = await PDFDocument.load(input.sourcePdfBytes, {
      updateMetadata: false,
    });
    doc.setCreator("pdf — client-side OCR");
    doc.setProducer("pdf-lib + tesseract.js");

    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pdfPages = doc.getPages();

    for (let i = 0; i < input.pageIndexMap.length; i++) {
      const overlayIdx = input.pageIndexMap[i];
      if (overlayIdx === undefined || overlayIdx < 0) continue;
      const overlay = input.pages[overlayIdx];
      if (!overlay) continue;

      const page = pdfPages[i];
      if (!page) continue;

      const { width: pageW, height: pageH } = page.getSize();
      const sxPerPx = pageW / overlay.ocr.pageSize.width;
      const syPerPx = pageH / overlay.ocr.pageSize.height;
      for (const word of overlay.ocr.words) {
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
