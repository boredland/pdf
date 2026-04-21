import { buildHocrDocument, type HocrPage } from "~/lib/export/hocr";
import { readOcrResult } from "~/lib/pipeline/ocr-pipeline";
import { readMrcManifest } from "~/lib/pipeline/mrc-pipeline";
import { getDb, type Project } from "~/lib/storage/db";

/**
 * Assemble a hOCR XHTML document for every OCR'd page in the project.
 * Pages without OCR results are skipped. Returns null when the project
 * has nothing to export (no pages or no OCR).
 */
export async function exportProjectHocr(
  project: Project,
): Promise<Blob | null> {
  const db = getDb();
  const pages = await db.pages
    .where({ projectId: project.id })
    .sortBy("index");

  const hocrPages: HocrPage[] = [];
  for (const page of pages) {
    const ocr = await readOcrResult(project.id, page.index);
    if (!ocr) continue;
    // Prefer the MRC manifest's dimensions — that's the coordinate frame
    // the OCR words are in. Fall back to the OCR result's pageSize.
    const manifest = await readMrcManifest(project.id, page.index);
    const widthPx = manifest?.width ?? ocr.pageSize.width;
    const heightPx = manifest?.height ?? ocr.pageSize.height;
    hocrPages.push({ pageIndex: page.index, ocr, widthPx, heightPx });
  }
  if (hocrPages.length === 0) return null;

  const xml = buildHocrDocument({
    projectName: project.name,
    pages: hocrPages,
  });
  return new Blob([xml], { type: "application/xhtml+xml" });
}
