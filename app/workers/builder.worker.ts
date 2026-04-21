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
      const { width: mediaW, height: mediaH } = page.getSize();

      // OCR ran on the preprocessed (rotated) image. We transform its
      // coords back to the source PDF's mediabox frame so the invisible
      // text lands on the right pixels regardless of page orientation.
      // /Rotate is NOT set — adding display rotation on top of coord
      // transforms is complex and easy to get wrong. The text matches
      // the scan orientation, so search/select works correctly. Viewers
      // that honour the source PDF's existing /Rotate (if any) will
      // still show the page in its original orientation.
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
 * source PDF's mediabox frame.
 *
 * The preprocess stage rotated the render image by `rot` degrees CW
 * before OCR. We need to undo that rotation on the word coordinates so
 * the invisible text lands at the same physical pixel position in the
 * unrotated source page.
 *
 * All coordinates are in top-left/y-down space (OCR convention).
 * drawInvisibleWord handles the final y-flip to PDF bottom-left/y-up.
 *
 * Derivation: if preprocess rotated the source image CW by R degrees,
 * the inverse is CCW by R (= CW by 360−R). Apply that inverse to each
 * OCR bbox to get back to source pixel positions.
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
    return { word, sx: mediaW / ocrW, sy: mediaH / ocrH };
  }

  // For 180°: source was WxH, preprocessed is WxH (same dims).
  // Inverse: rotate 180° = flip both axes.
  // Source pixel (sx, sy) = (ocrW - x - w, ocrH - y - h).
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

  // For 90° CW preprocess: source was HxW (portrait), preprocessed is WxH
  // (landscape, rotated CW). Inverse is 90° CCW = 270° CW.
  // Source pixel: (sy, ocrW - sx - sw) where s=source, o=ocr.
  // In terms of OCR bbox (x, y, w, h):
  //   source_x = y, source_y = ocrW - x - w, source_w = h, source_h = w
  if (rot === 90) {
    return {
      word: {
        ...word,
        bbox: { x: y, y: ocrW - x - w, width: h, height: w },
      },
      // Source image dims were ocrH × ocrW (swapped).
      sx: mediaW / ocrH,
      sy: mediaH / ocrW,
    };
  }

  // For 270° CW preprocess: source was HxW, preprocessed is WxH
  // (rotated 270° CW = 90° CCW). Inverse is 90° CW.
  // Source pixel: (ocrH - y - h, x), source_w = h, source_h = w.
  return {
    word: {
      ...word,
      bbox: { x: ocrH - y - h, y: x, width: h, height: w },
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
