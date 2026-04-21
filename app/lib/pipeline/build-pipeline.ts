import { settingsHash } from "~/lib/artifacts";
import { emitProgress } from "~/lib/progress";
import { readBlob, removeFile, writeFile } from "~/lib/storage/opfs";
import { getDb, type Project } from "~/lib/storage/db";
import { readOcrResult } from "~/lib/pipeline/ocr-pipeline";
import { buildPdf } from "~/lib/workers/builder-client";
import type { OverlayPageInput } from "~/workers/builder.worker";

export interface BuildPipelineOptions {
  signal?: AbortSignal;
}

function isAborted(signal?: AbortSignal) {
  return signal?.aborted ?? false;
}

export async function runBuildPipeline(
  project: Project,
  options: BuildPipelineOptions = {},
): Promise<void> {
  const db = getDb();
  const hash = await settingsHash(project.settings, "build");

  const pages = await db.pages.where({ projectId: project.id }).sortBy("index");

  // The overlay approach only needs OCR output — MRC is no longer required
  // for building. Pages without OCR are left as-is in the source PDF.
  const missing = pages.filter((p) => !p.status.ocr);
  if (missing.length > 0) {
    emitProgress({
      kind: "stage",
      projectId: project.id,
      pageIndex: -1,
      stage: "build",
      status: "failed",
      error: `missing ocr on ${missing.length} page(s)`,
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
    // Read the original source PDF — we'll hand it to the builder worker
    // which loads it via pdf-lib and adds invisible text on top.
    const sourceBlob = await readBlob(project.sourcePdfPath);
    if (!sourceBlob) throw new Error("source PDF missing from OPFS");
    const sourcePdfBytes = await sourceBlob.arrayBuffer();

    const overlayPages: OverlayPageInput[] = [];
    const pageIndexMap: number[] = [];

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
      const ocr = await readOcrResult(project.id, page.index);
      if (!ocr) {
        pageIndexMap.push(-1);
        continue;
      }
      // The applied rotation comes from preprocess (OSD or manual override).
      // The builder sets /Rotate on the PDF page so viewers display it
      // upright — without re-encoding.
      const appliedRotation =
        (page.rotationOverride ??
          page.status.preprocess?.osdAngleDegrees ??
          0) as 0 | 90 | 180 | 270;
      pageIndexMap.push(overlayPages.length);
      overlayPages.push({
        ocr,
        pageWidthPt: ocr.pageSize.width,
        pageHeightPt: ocr.pageSize.height,
        appliedRotation,
      });
    }

    const result = await buildPdf({
      projectName: project.name,
      sourcePdfBytes,
      pages: overlayPages,
      pageIndexMap,
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
