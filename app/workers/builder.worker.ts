/// <reference lib="webworker" />
import * as Comlink from "comlink";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import type { OcrResult, OcrWord } from "~/lib/providers/types";

/** Per-page OCR data needed for the overlay. */
export interface OverlayPageInput {
  ocr: OcrResult;
  pageWidthPt: number;
  pageHeightPt: number;
  appliedRotation?: 0 | 90 | 180 | 270;
}

export interface BuilderInput {
  projectName: string;
  sourcePdfBytes: ArrayBuffer;
  pages: OverlayPageInput[];
  pageIndexMap: number[];
}

export interface BuilderOutput {
  pdfBytes: ArrayBuffer;
}

const api = {
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

      const rot = overlay.appliedRotation ?? 0;
      const { width: mw, height: mh } = page.getSize();

      if (rot !== 0) {
        page.setRotation(degrees(rot));
      }

      // OCR coordinates are in the rotated (corrected) image frame:
      //   origin top-left, y-down, dimensions ocrW × ocrH.
      // We need to place text in the PDF mediabox (origin bottom-left,
      // y-up, dimensions mw × mh) such that after the viewer applies
      // /Rotate, the text appears at the OCR position on screen.
      //
      // Strategy:
      //   1. Convert OCR coord → desired display position (PDF coords)
      //   2. Invert the /Rotate transform → mediabox position
      //   3. Call page.drawText at that mediabox position
      const ocrW = overlay.ocr.pageSize.width;
      const ocrH = overlay.ocr.pageSize.height;

      // Display dimensions after /Rotate:
      const swap = rot === 90 || rot === 270;
      const dispW = swap ? mh : mw;
      const dispH = swap ? mw : mh;
      const sx = dispW / ocrW;
      const sy = dispH / ocrH;

      for (const word of overlay.ocr.words) {
        if (!word.text.trim()) continue;
        // Skip OCR noise: very short fragments and low-confidence guesses
        // add bytes without helping search.
        if (word.text.length < 2 && word.confidence < 0.5) continue;
        if (word.confidence < 0.2) continue;

        const bx = word.bbox.x;
        const by = word.bbox.y;
        const bw = word.bbox.width;
        const bh = word.bbox.height;

        // Desired display position (PDF coords: bottom-left, y-up):
        const dx = bx * sx;
        const dy = dispH - (by + bh) * sy;

        // Font sizing (in display-frame points):
        const textH = bh * sy;
        let fontSize = Math.max(1, textH * 0.85);
        const measured = font.widthOfTextAtSize(word.text, fontSize);
        const textW = bw * sx;
        if (measured > textW && measured > 0) {
          fontSize *= textW / measured;
        }

        // Invert /Rotate to get mediabox coords.
        // /Rotate R means the viewer rotates CW by R.
        // Display(mx,my) for each R:
        //   0:   (mx, my)
        //   90:  (my, mw - mx)
        //   180: (mw - mx, mh - my)
        //   270: (mh - my, mx)
        // Inverting:
        let mx: number, my: number;
        if (rot === 0) {
          mx = dx;
          my = dy;
        } else if (rot === 90) {
          mx = mw - dy;
          my = dx;
        } else if (rot === 180) {
          mx = mw - dx;
          my = mh - dy;
        } else {
          // 270
          mx = dy;
          my = mh - dx;
        }

        page.drawText(word.text, {
          x: mx,
          y: my,
          size: fontSize,
          font,
          opacity: 0,
        });
      }
    }

    const bytes = await doc.save({ useObjectStreams: true });
    const transferable = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(transferable).set(bytes);
    return Comlink.transfer({ pdfBytes: transferable }, [transferable]);
  },
};

export type BuilderWorkerApi = typeof api;

Comlink.expose(api);
