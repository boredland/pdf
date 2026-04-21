import { buildAltoDocument, type AltoPage } from "~/lib/export/alto";
import { buildHocrDocument, type HocrPage } from "~/lib/export/hocr";
import { readOcrResult } from "~/lib/pipeline/ocr-pipeline";
import { readMrcManifest } from "~/lib/pipeline/mrc-pipeline";
import { getDb, type Project } from "~/lib/storage/db";

interface ShapedPage {
  pageIndex: number;
  ocr: Awaited<ReturnType<typeof readOcrResult>>;
  widthPx: number;
  heightPx: number;
}

async function collectPages(projectId: string): Promise<ShapedPage[]> {
  const db = getDb();
  const rows = await db.pages.where({ projectId }).sortBy("index");
  const shaped: ShapedPage[] = [];
  for (const row of rows) {
    const ocr = await readOcrResult(projectId, row.index);
    if (!ocr) continue;
    const manifest = await readMrcManifest(projectId, row.index);
    const widthPx = manifest?.width ?? ocr.pageSize.width;
    const heightPx = manifest?.height ?? ocr.pageSize.height;
    shaped.push({ pageIndex: row.index, ocr, widthPx, heightPx });
  }
  return shaped;
}

/**
 * Assemble a hOCR XHTML document for every OCR'd page in the project.
 * Pages without OCR results are skipped. Returns null when the project
 * has nothing to export (no pages or no OCR).
 */
export async function exportProjectHocr(
  project: Project,
): Promise<Blob | null> {
  const shaped = await collectPages(project.id);
  if (shaped.length === 0) return null;
  const xml = buildHocrDocument({
    projectName: project.name,
    pages: shaped as HocrPage[],
  });
  return new Blob([xml], { type: "application/xhtml+xml" });
}

/**
 * Assemble an ALTO XML document for every OCR'd page. Same page
 * selection + dimensions logic as the hOCR export.
 */
export async function exportProjectAlto(
  project: Project,
): Promise<Blob | null> {
  const shaped = await collectPages(project.id);
  if (shaped.length === 0) return null;
  const xml = buildAltoDocument({
    projectName: project.name,
    pages: shaped as AltoPage[],
  });
  return new Blob([xml], { type: "application/xml" });
}
