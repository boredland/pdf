import { artifactPath, settingsHash } from "~/lib/artifacts";
import { emitProgress } from "~/lib/progress";
import { readBlob, removeFile, writeFile } from "~/lib/storage/opfs";
import { getDb, type Project } from "~/lib/storage/db";
import { detectPage } from "~/lib/workers/preprocess-client";

export interface DetectPipelineOptions {
  signal?: AbortSignal;
  pageIndices?: number[];
}

function isAborted(signal?: AbortSignal) {
  return signal?.aborted ?? false;
}

export async function runDetectPipeline(
  project: Project,
  options: DetectPipelineOptions = {},
): Promise<void> {
  const db = getDb();
  if (!project.settings.detect.enabled) return;
  const hash = await settingsHash(project.settings, "detect");
  const targetIndices = options.pageIndices ?? [
    ...Array.from({ length: project.pageCount }, (_, i) => i),
  ];

  for (const pageIndex of targetIndices) {
    if (isAborted(options.signal)) {
      emitProgress({
        kind: "stage",
        projectId: project.id,
        pageIndex,
        stage: "detect",
        status: "aborted",
        ts: Date.now(),
      });
      return;
    }

    const page = await db.pages.get(`${project.id}:${pageIndex}`);
    if (!page?.status?.preprocess) {
      emitProgress({
        kind: "stage",
        projectId: project.id,
        pageIndex,
        stage: "detect",
        status: "failed",
        error: "no preprocess artifact",
        ts: Date.now(),
      });
      continue;
    }

    const existing = page.status.detect;
    if (existing && existing.hash === hash) {
      const blob = await readBlob(existing.artifactPath);
      if (blob) {
        emitProgress({
          kind: "stage",
          projectId: project.id,
          pageIndex,
          stage: "detect",
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
      stage: "detect",
      status: "running",
      ts: Date.now(),
    });

    try {
      const [renderBlob, preBlob] = await Promise.all([
        readBlob(page.status.render?.artifactPath ?? ""),
        readBlob(page.status.preprocess.artifactPath),
      ]);
      if (!renderBlob) throw new Error("render artifact missing — cannot overlay");
      if (!preBlob) throw new Error("preprocess artifact missing — cannot analyse");
      const [renderBytes, preBytes] = await Promise.all([
        renderBlob.arrayBuffer(),
        preBlob.arrayBuffer(),
      ]);
      const result = await detectPage({
        renderPngBytes: renderBytes,
        preprocessedPngBytes: preBytes,
        skewAngleDegrees: page.status.preprocess.skewAngleDegrees ?? 0,
        osdAngleDegrees: page.status.preprocess.osdAngleDegrees ?? 0,
        pageIndex,
      });

      if (isAborted(options.signal)) {
        emitProgress({
          kind: "stage",
          projectId: project.id,
          pageIndex,
          stage: "detect",
          status: "aborted",
          ts: Date.now(),
        });
        return;
      }

      if (existing) {
        await Promise.all([
          removeFile(existing.artifactPath).catch(() => undefined),
          existing.overlayPath
            ? removeFile(existing.overlayPath).catch(() => undefined)
            : Promise.resolve(),
        ]);
      }
      const path = artifactPath({
        projectId: project.id,
        pageIndex,
        stage: "detect",
        hash,
        extension: "json",
      });
      const overlayPath = `${project.id}/pages/${pageIndex}/detect-overlay.${hash}.png`;
      const payload = JSON.stringify({
        regions: result.regions,
        width: result.width,
        height: result.height,
        overlayPath,
      });
      await Promise.all([
        writeFile(path, new TextEncoder().encode(payload)),
        writeFile(overlayPath, new Uint8Array(result.overlayPngBytes)),
      ]);

      await db.pages.update(`${project.id}:${pageIndex}`, {
        status: {
          ...(page.status ?? {}),
          detect: {
            hash,
            completedAt: Date.now(),
            artifactPath: path,
            overlayPath,
            sizeBytes: payload.length + result.overlayPngBytes.byteLength,
          },
        },
        thumbnailDataUrl: result.overlayDataUrl,
        thumbnails: {
          ...(page.thumbnails ?? {}),
          detect: result.overlayDataUrl,
        },
      });

      emitProgress({
        kind: "stage",
        projectId: project.id,
        pageIndex,
        stage: "detect",
        status: "done",
        thumbnail: result.overlayDataUrl,
        sizeBytes: payload.length,
        ts: Date.now(),
      });
    } catch (err) {
      emitProgress({
        kind: "stage",
        projectId: project.id,
        pageIndex,
        stage: "detect",
        status: "failed",
        error: (err as Error).message,
        ts: Date.now(),
      });
      throw err;
    }
  }
}

export async function readDetectRegions(
  projectId: string,
  pageIndex: number,
): Promise<{ regions: { x: number; y: number; width: number; height: number }[]; width: number; height: number } | null> {
  const db = getDb();
  const page = await db.pages.get(`${projectId}:${pageIndex}`);
  if (!page?.status?.detect) return null;
  const blob = await readBlob(page.status.detect.artifactPath);
  if (!blob) return null;
  return JSON.parse(await blob.text());
}
