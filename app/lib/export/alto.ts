/**
 * Build an ALTO (Analyzed Layout and Text Object) XML document from a
 * project's OCR results.
 *
 * ALTO 4.1 is the common exchange format for structured OCR output in
 * digital-library ecosystems (IIIF viewers, METS metadata, etc.). We
 * emit a minimal but conformant subset:
 *
 *   <alto><Layout><Page><PrintSpace>
 *     <TextBlock><TextLine><String CONTENT=".."/></TextLine></TextBlock>
 *   </PrintSpace></Page></Layout></alto>
 *
 * Spec: https://www.loc.gov/standards/alto/v4/alto-4-1.xsd
 */

import type { OcrResult } from "~/lib/providers/types";

export interface AltoPage {
  pageIndex: number;
  ocr: OcrResult;
  widthPx: number;
  heightPx: number;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function round(n: number): number {
  return Math.round(n);
}

export interface BuildAltoInput {
  projectName: string;
  pages: AltoPage[];
}

export function buildAltoDocument(input: BuildAltoInput): string {
  const pagesXml = input.pages
    .map((p) => renderPage(p))
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xsi:schemaLocation="http://www.loc.gov/standards/alto/ns-v4# http://www.loc.gov/standards/alto/v4/alto-4-1.xsd">
  <Description>
    <MeasurementUnit>pixel</MeasurementUnit>
    <sourceImageInformation>
      <fileName>${esc(input.projectName)}</fileName>
    </sourceImageInformation>
    <OCRProcessing ID="OCR_pdf">
      <ocrProcessingStep>
        <processingSoftware>
          <softwareName>pdf — client-side OCR</softwareName>
        </processingSoftware>
      </ocrProcessingStep>
    </OCRProcessing>
  </Description>
  <Layout>
${pagesXml}
  </Layout>
</alto>`;
}

function renderPage(page: AltoPage): string {
  const { widthPx, heightPx, ocr, pageIndex } = page;
  const lines = ocr.lines.length > 0
    ? ocr.lines
    : [
        {
          text: ocr.text,
          bbox: { x: 0, y: 0, width: widthPx, height: heightPx },
          words: ocr.words,
        },
      ];

  // Single TextBlock per page — ALTO allows multiple but we don't have
  // paragraph-level structure from any provider today.
  const linesXml = lines
    .map((line, li) => {
      const stringXml = line.words
        .map(
          (w, wi) =>
            `          <String ID="word_${pageIndex + 1}_${li + 1}_${wi + 1}" HPOS="${round(
              w.bbox.x,
            )}" VPOS="${round(w.bbox.y)}" WIDTH="${round(
              w.bbox.width,
            )}" HEIGHT="${round(w.bbox.height)}" CONTENT="${esc(
              w.text,
            )}" WC="${w.confidence.toFixed(2)}"/>`,
        )
        .join("\n");
      return `        <TextLine ID="line_${pageIndex + 1}_${li + 1}" HPOS="${round(
        line.bbox.x,
      )}" VPOS="${round(line.bbox.y)}" WIDTH="${round(
        line.bbox.width,
      )}" HEIGHT="${round(line.bbox.height)}">
${stringXml}
        </TextLine>`;
    })
    .join("\n");

  return `    <Page ID="page_${pageIndex + 1}" PHYSICAL_IMG_NR="${
    pageIndex + 1
  }" WIDTH="${widthPx}" HEIGHT="${heightPx}">
      <PrintSpace HPOS="0" VPOS="0" WIDTH="${widthPx}" HEIGHT="${heightPx}">
        <TextBlock ID="block_${pageIndex + 1}" HPOS="0" VPOS="0" WIDTH="${widthPx}" HEIGHT="${heightPx}">
${linesXml}
        </TextBlock>
      </PrintSpace>
    </Page>`;
}
