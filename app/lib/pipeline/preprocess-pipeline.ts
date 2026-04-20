import { artifactPath, settingsHash } from "~/lib/artifacts";
import { emitProgress } from "~/lib/progress";
import { readBlob, removeFile, writeFile } from "~/lib/storage/opfs";
import { getDb, type Project } from "~/lib/storage/db";
import { preprocessPage } from "~/lib/workers/preprocess-client";
import { detectOrientation } from "~/lib/images/osd";

export interface PreprocessPipelineOptions {
  signal?: AbortSignal;
  pageIndices?: number[];
}

function isAborted(signal?: AbortSignal) {
  return signal?.aborted ?? false;
}

export async function runPreprocessPipeline(
  project: Project,
  options: PreprocessPipelineOptions = {},
): Promise<void> {
  const db = getDb();
  const hash = await settingsHash(project.settings, "preprocess");
  const targetIndices = options.pageIndices ?? [
    ...Array.from({ length: project.pageCount }, (_, i) => i),
  ];

  for (const pageIndex of targetIndices) {
    if (isAborted(options.signal)) {
      emitProgress({
        kind: "stage",
        projectId: project.id,
        pageIndex,
        stage: "preprocess",
        status: "aborted",
        ts: Date.now(),
      });
      return;
    }

    const page = await db.pages.get(`${project.id}:${pageIndex}`);
    if (!page?.status?.render) {
      emitProgress({
        kind: "stage",
        projectId: project.id,
        pageIndex,
        stage: "preprocess",
        status: "failed",
        error: "no render artifact",
        ts: Date.now(),
      });
      continue;
    }

    const existing = page.status.preprocess;
    if (existing && existing.hash === hash) {
      const blob = await readBlob(existing.artifactPath);
      if (blob) {
        emitProgress({
          kind: "stage",
          projectId: project.id,
          pageIndex,
          stage: "preprocess",
          status: "cached",
          thumbnail: page.thumbnailDataUrl,
          sizeBytes: blob.size,
          ts: Date.now(),
        });
        continue;
      }
    }

    emitProgress({
      kind: "stage",
      projectId: project.id,
      pageIndex,
      stage: "preprocess",
      status: "running",
      ts: Date.now(),
    });

    try {
      const renderBlob = await readBlob(page.status.render.artifactPath);
      if (!renderBlob) throw new Error("render artifact missing on disk");
      const pngBytes = await renderBlob.arrayBuffer();

      // Ask OSD whether this page is upside-down. If the setting is off or
      // OSD fails/times out, the helper returns angle=0 and we proceed as
      // if nothing needed flipping.
      let osdAngleDegrees: 0 | 180 = 0;
      if (project.settings.preprocess.orientationDetect) {
        const osd = await detectOrientation(pngBytes);
        osdAngleDegrees = osd.angle;
      }

      const result = await preprocessPage({
        pngBytes,
        pageIndex,
        deskew: project.settings.preprocess.deskew,
        binarizer: project.settings.preprocess.binarizer,
        denoiseRadius: project.settings.preprocess.denoiseRadius,
        osdAngleDegrees,
      });

      if (isAborted(options.signal)) {
        emitProgress({
          kind: "stage",
          projectId: project.id,
          pageIndex,
          stage: "preprocess",
          status: "aborted",
          ts: Date.now(),
        });
        return;
      }

      if (existing) await removeFile(existing.artifactPath).catch(() => undefined);

      const path = artifactPath({
        projectId: project.id,
        pageIndex,
        stage: "preprocess",
        hash,
        extension: "png",
      });
      await writeFile(path, new Uint8Array(result.pngBytes));

      await db.pages.update(`${project.id}:${pageIndex}`, {
        status: {
          ...(page.status ?? {}),
          preprocess: {
            hash,
            completedAt: Date.now(),
            artifactPath: path,
            sizeBytes: result.pngBytes.byteLength,
            skewAngleDegrees: result.skewAngleDegrees,
            osdAngleDegrees: result.osdAngleDegrees,
          },
        },
        thumbnailDataUrl: result.thumbnailDataUrl,
        thumbnails: {
          ...(page.thumbnails ?? {}),
          preprocess: result.thumbnailDataUrl,
        },
      });

      emitProgress({
        kind: "stage",
        projectId: project.id,
        pageIndex,
        stage: "preprocess",
        status: "done",
        thumbnail: result.thumbnailDataUrl,
        sizeBytes: result.pngBytes.byteLength,
        ts: Date.now(),
      });
    } catch (err) {
      emitProgress({
        kind: "stage",
        projectId: project.id,
        pageIndex,
        stage: "preprocess",
        status: "failed",
        error: (err as Error).message,
        ts: Date.now(),
      });
      throw err;
    }
  }
}
