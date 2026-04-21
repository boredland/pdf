/// <reference lib="webworker" />
import * as Comlink from "comlink";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import type { OcrResult, OcrWord } from "~/lib/providers/types";

/** Per-page OCR data needed for the overlay. */
export interface OverlayPageInput {
  ocr: OcrResult;
  /** Physical page size in points (72 DPI base). */
  pageWidthPt: number;
  pageHeightPt: number;
  /**
   * Rotation applied during preprocess (OSD or manual). The builder sets
   * the PDF page's /Rotate property to this value so viewers display the
   * page upright — without re-encoding any image data.
   */
  appliedRotation?: 0 | 90 | 180 | 270;
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

      const rot = overlay.appliedRotation ?? 0;

      // Set the /Rotate flag so viewers display the page upright.
      // This is metadata only — no image re-encoding.
      if (rot !== 0) {
        page.setRotation(degrees(rot));
      }

      // After rotation the "visible" page size changes for 90/270,
      // but pdf-lib's page.getSize() returns the *mediabox* size
      // (pre-rotation). For text placement we need the mediabox coords
      // because drawText operates in that frame.
      const { width: mediaW, height: mediaH } = page.getSize();

      // OCR ran on the rotated image, so its coordinate frame matches
      // the rotated (displayed) frame. We need to map OCR coords back
      // to the unrotated mediabox for drawText.
      for (const word of overlay.ocr.words) {
        if (!word.text.trim()) continue;
        const mapped = mapWordToMediaBox(
          word,
          overlay.ocr.pageSize,
          mediaW,
          mediaH,
          rot,
        );
        drawInvisibleWord(page, font, mapped.word, mapped.sx, mapped.sy, mediaH);
      }
    }

    const bytes = await doc.save();
    const transferable = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(transferable).set(bytes);
    return Comlink.transfer({ pdfBytes: transferable }, [transferable]);
  },
};

/**
 * Map a word's bbox from the OCR (rotated) coordinate frame back to the
 * PDF mediabox (unrotated) frame. The /Rotate flag tells the viewer to
 * rotate the display, but drawText operates in the raw mediabox coords.
 *
 * OCR frame: top-left origin, y-down, dimensions = rotated image size.
 * Mediabox:  bottom-left origin, y-up, dimensions = unrotated page.
 *
 * For rot=0  → identity (direct mapping).
 * For rot=180 → flip both axes: (ocrW-x-w, ocrH-y-h).
 * For rot=90  → CW rotation: page was rendered landscape from portrait.
 * For rot=270 → CCW rotation.
 */
function mapWordToMediaBox(
  word: OcrWord,
  ocrSize: { width: number; height: number },
  mediaW: number,
  mediaH: number,
  rot: 0 | 90 | 180 | 270,
): { word: OcrWord; sx: number; sy: number } {
  const { x, y, width: w, height: h } = word.bbox;
  const ocrW = ocrSize.width;
  const ocrH = ocrSize.height;

  if (rot === 0) {
    return {
      word,
      sx: mediaW / ocrW,
      sy: mediaH / ocrH,
    };
  }

  if (rot === 180) {
    return {
      word: {
        ...word,
        bbox: { x: ocrW - x - w, y: ocrH - y - h, width: w, height: h },
      },
      sx: mediaW / ocrW,
      sy: mediaH / ocrH,
    };
  }

  if (rot === 90) {
    // OCR image was rotated 90° CW from the source. In OCR frame (ocrW×ocrH)
    // the source was (ocrH×ocrW). Mediabox is (mediaW×mediaH) = (ocrH×ocrW)-scale.
    return {
      word: {
        ...word,
        bbox: { x: ocrH - y - h, y: x, width: h, height: w },
      },
      sx: mediaW / ocrH,
      sy: mediaH / ocrW,
    };
  }

  // rot === 270
  return {
    word: {
      ...word,
      bbox: { x: y, y: ocrW - x - w, width: h, height: w },
    },
    sx: mediaW / ocrH,
    sy: mediaH / ocrW,
  };
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
