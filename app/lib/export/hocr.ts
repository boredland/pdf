/**
 * Build a single-document hOCR file from a project's per-page OCR
 * results. hOCR is the canonical structured output format for OCR
 * engines — it's valid XHTML with per-word bbox metadata that tools
 * like pdfsandwich, ABBYY, and internal indexers can consume.
 *
 * Spec reference: https://kba.github.io/hocr-spec/1.2/
 *
 * We prefer the provider's native `hocr` field (Tesseract emits rich
 * hOCR with paragraph/line/word structure). For providers that only
 * return plain text + synthetic bboxes (Gemini, Mistral), we synthesise
 * a minimal hOCR from OcrResult.words/lines.
 */

import type { OcrResult } from "~/lib/providers/types";

export interface HocrPage {
  pageIndex: number;
  ocr: OcrResult;
  /** Physical page size in pixels — typically the preprocessed PNG size. */
  widthPx: number;
  heightPx: number;
}

/** Escape strings for HTML attribute/text contexts. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function bboxTitle(b: { x: number; y: number; width: number; height: number }) {
  return `bbox ${Math.round(b.x)} ${Math.round(b.y)} ${Math.round(
    b.x + b.width,
  )} ${Math.round(b.y + b.height)}`;
}

/**
 * Wrap a provider's `hocr` string so it drops into a multi-page hOCR
 * doc. Tesseract's raw hocr output is a complete XHTML doc — we strip
 * the outer `<html>/<body>/<meta>` wrapper and keep only the
 * `<div class="ocr_page">` blocks, then renumber them so page IDs
 * are unique in the combined file.
 */
function extractPageBlock(rawHocr: string, pageIndex: number): string | null {
  const match = rawHocr.match(
    /<div[^>]*class=["'][^"']*ocr_page[^"']*["'][^>]*>[\s\S]*?<\/div>/,
  );
  if (!match) return null;
  const block = match[0];
  return block.replace(
    /id=["'][^"']*["']/,
    `id="page_${pageIndex + 1}"`,
  );
}

/** Build an ocr_page block from scratch when the provider gives us none. */
function synthesisePage(
  pageIndex: number,
  page: HocrPage,
): string {
  const { widthPx, heightPx, ocr } = page;
  const lines = ocr.lines.length > 0
    ? ocr.lines
    : [
        {
          text: ocr.text,
          bbox: { x: 0, y: 0, width: widthPx, height: heightPx },
          words: ocr.words,
        },
      ];

  const linesXhtml = lines
    .map((line, li) => {
      const wordsXhtml = line.words
        .map(
          (w, wi) =>
            `<span class="ocrx_word" id="word_${pageIndex + 1}_${li + 1}_${
              wi + 1
            }" title="${bboxTitle(w.bbox)}; x_wconf ${Math.round(
              w.confidence * 100,
            )}">${esc(w.text)}</span>`,
        )
        .join(" ");
      return `  <span class="ocr_line" id="line_${pageIndex + 1}_${
        li + 1
      }" title="${bboxTitle(line.bbox)}">${wordsXhtml}</span>`;
    })
    .join("\n");

  return `<div class="ocr_page" id="page_${
    pageIndex + 1
  }" title="bbox 0 0 ${widthPx} ${heightPx}; ppageno ${pageIndex}">
${linesXhtml}
</div>`;
}

export interface BuildHocrInput {
  projectName: string;
  pages: HocrPage[];
}

export function buildHocrDocument(input: BuildHocrInput): string {
  const pagesXhtml = input.pages
    .map((p) => {
      // Prefer the provider's native hocr only if it carries line/word
      // structure (signals Tesseract). Minimal stubs (e.g. the mock
      // provider returns just an empty `<div class="ocr_page">`) round-
      // trip via synthesise so consumers always see ocr_line/ocrx_word.
      const hasStructure =
        p.ocr.hocr.includes("ocr_line") || p.ocr.hocr.includes("ocrx_word");
      const native = hasStructure
        ? extractPageBlock(p.ocr.hocr, p.pageIndex)
        : null;
      return native ?? synthesisePage(p.pageIndex, p);
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html;charset=utf-8" />
<meta name="ocr-system" content="pdf — client-side OCR" />
<meta name="ocr-capabilities" content="ocr_page ocr_line ocrx_word" />
<title>${esc(input.projectName)}</title>
</head>
<body>
${pagesXhtml}
</body>
</html>`;
}
