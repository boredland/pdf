import { settingsHash } from "~/lib/artifacts";
import { emitProgress } from "~/lib/progress";
import { readBlob, removeFile, writeFile } from "~/lib/storage/opfs";
import { getDb, type Project } from "~/lib/storage/db";
import { readOcrResult } from "~/lib/pipeline/ocr-pipeline";
import { readMrcManifest } from "~/lib/pipeline/mrc-pipeline";
import { buildPdf } from "~/lib/workers/builder-client";
import type { BuilderPageInput } from "~/workers/builder.worker";

export interface BuildPipelineOptions {
  signal?: AbortSignal;
}

function isAborted(signal?: AbortSignal) {
  return signal?.aborted ?? false;
}

/**
 * Page physical size in PDF points. MuPDF defaults render at 72 DPI × scale,
 * so at 300 DPI an 8.5"×11" page lands at 2550×3300 pixels. The PDF page
 * itself stays at the physical size (612×792 pt); we just render images
 * and project OCR bboxes onto it.
 */
function pageSizePoints(renderWidthPx: number, renderHeightPx: number, renderDpi: number) {
  const scale = 72 / renderDpi;
  return {
    widthPt: renderWidthPx * scale,
    heightPt: renderHeightPx * scale,
  };
}

export async function runBuildPipeline(
  project: Project,
  options: BuildPipelineOptions = {},
): Promise<void> {
  const db = getDb();
  const hash = await settingsHash(project.settings, "build");

  // Short-circuit: every page needs an OCR artifact and an MRC composed
  // artifact. Missing any of those is a user-actionable error, not a crash.
  const pages = await db.pages.where({ projectId: project.id }).sortBy("index");
  if (pages.length !== project.pageCount) {
    emitProgress({
      kind: "stage",
      projectId: project.id,
      pageIndex: -1,
      stage: "build",
      status: "failed",
      error: "page rows missing",
      ts: Date.now(),
    });
    return;
  }

  const missing = pages.filter((p) => !p.status.ocr || !p.status.mrc);
  if (missing.length > 0) {
    emitProgress({
      kind: "stage",
      projectId: project.id,
      pageIndex: -1,
      stage: "build",
      status: "failed",
      error: `missing ocr/mrc on ${missing.length} page(s)`,
      ts: Date.now(),
    });
    return;
  }

  if (project.build && project.build.hash === hash) {
    const existingBlob = await readBlob(project.build.artifactPath);
    if (existingBlob) {
      emitProgress({
        kind: "stage",
        projectId: project.id,
        pageIndex: -1,
        stage: "build",
        status: "cached",
        sizeBytes: existingBlob.size,
        ts: Date.now(),
      });
      return;
    }
  }

  emitProgress({
    kind: "stage",
    projectId: project.id,
    pageIndex: -1,
    stage: "build",
    status: "running",
    ts: Date.now(),
  });

  try {
    const pageInputs: BuilderPageInput[] = [];
    for (const page of pages) {
      if (isAborted(options.signal)) {
        emitProgress({
          kind: "stage",
          projectId: project.id,
          pageIndex: -1,
          stage: "build",
          status: "aborted",
          ts: Date.now(),
        });
        return;
      }
      const manifest = await readMrcManifest(project.id, page.index);
      if (!manifest) throw new Error(`page ${page.index}: missing mrc manifest`);
      const [maskBlob, bgBlob] = await Promise.all([
        readBlob(manifest.maskPath),
        readBlob(manifest.bgPath),
      ]);
      if (!maskBlob) throw new Error(`page ${page.index}: mask image missing`);
      if (!bgBlob) throw new Error(`page ${page.index}: background image missing`);
      const ocr = await readOcrResult(project.id, page.index);
      if (!ocr) throw new Error(`page ${page.index}: missing ocr result`);

      const { widthPt, heightPt } = pageSizePoints(
        manifest.width,
        manifest.height,
        project.settings.render.dpi,
      );
      pageInputs.push({
        maskPngBytes: await maskBlob.arrayBuffer(),
        bgBytes: await bgBlob.arrayBuffer(),
        bgMimeType: manifest.bgMimeType,
        skipMask: manifest.skipMask,
        ocr,
        pageWidthPt: widthPt,
        pageHeightPt: heightPt,
      });
    }

    const result = await buildPdf({
      projectName: project.name,
      pages: pageInputs,
    });

    if (isAborted(options.signal)) {
      emitProgress({
        kind: "stage",
        projectId: project.id,
        pageIndex: -1,
        stage: "build",
        status: "aborted",
        ts: Date.now(),
      });
      return;
    }

    if (project.build) {
      await removeFile(project.build.artifactPath).catch(() => undefined);
    }

    const path = `${project.id}/output.${hash}.pdf`;
    await writeFile(path, new Uint8Array(result.pdfBytes));

    await db.projects.update(project.id, {
      build: {
        hash,
        completedAt: Date.now(),
        artifactPath: path,
        sizeBytes: result.pdfBytes.byteLength,
      },
    });

    emitProgress({
      kind: "stage",
      projectId: project.id,
      pageIndex: -1,
      stage: "build",
      status: "done",
      sizeBytes: result.pdfBytes.byteLength,
      ts: Date.now(),
    });
  } catch (err) {
    emitProgress({
      kind: "stage",
      projectId: project.id,
      pageIndex: -1,
      stage: "build",
      status: "failed",
      error: (err as Error).message,
      ts: Date.now(),
    });
    throw err;
  }
}

export async function readBuildOutput(projectId: string): Promise<Blob | null> {
  const db = getDb();
  const project = await db.projects.get(projectId);
  if (!project?.build) return null;
  return readBlob(project.build.artifactPath);
}
