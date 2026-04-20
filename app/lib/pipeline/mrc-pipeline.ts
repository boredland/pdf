import { artifactPath, settingsHash } from "~/lib/artifacts";
import { emitProgress } from "~/lib/progress";
import { getDb, type Project } from "~/lib/storage/db";
import { readBlob, removeFile, writeFile } from "~/lib/storage/opfs";
import { splitMrc } from "~/lib/workers/mrc-client";

export interface MrcPipelineOptions {
  signal?: AbortSignal;
  pageIndices?: number[];
}

export interface MrcArtifactManifest {
  maskPath: string;
  bgPath: string;
  bgMimeType: string;
  composedPath: string;
  width: number;
  height: number;
  bgWidth: number;
  bgHeight: number;
  maskBytes: number;
  bgBytes: number;
  originalBytes: number;
  meanAbsoluteDifference: number;
  preset: Project["settings"]["mrc"]["preset"];
}

function isAborted(signal?: AbortSignal) {
  return signal?.aborted ?? false;
}

export async function runMrcPipeline(
  project: Project,
  options: MrcPipelineOptions = {},
): Promise<void> {
  const db = getDb();
  const hash = await settingsHash(project.settings, "mrc");
  const indices =
    options.pageIndices ?? [...Array.from({ length: project.pageCount }, (_, i) => i)];

  for (const pageIndex of indices) {
    if (isAborted(options.signal)) {
      emitProgress({
        kind: "stage",
        projectId: project.id,
        pageIndex,
        stage: "mrc",
        status: "aborted",
        ts: Date.now(),
      });
      return;
    }

    const page = await db.pages.get(`${project.id}:${pageIndex}`);
    if (!page?.status?.render || !page.status.preprocess) {
      emitProgress({
        kind: "stage",
        projectId: project.id,
        pageIndex,
        stage: "mrc",
        status: "failed",
        error: "render or preprocess artifact missing",
        ts: Date.now(),
      });
      continue;
    }

    const existing = page.status.mrc;
    if (existing && existing.hash === hash) {
      const blob = await readBlob(existing.artifactPath);
      if (blob) {
        emitProgress({
          kind: "stage",
          projectId: project.id,
          pageIndex,
          stage: "mrc",
          status: "cached",
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
      stage: "mrc",
      status: "running",
      ts: Date.now(),
    });

    try {
      const [renderBlob, preBlob] = await Promise.all([
        readBlob(page.status.render.artifactPath),
        readBlob(page.status.preprocess.artifactPath),
      ]);
      if (!renderBlob || !preBlob) throw new Error("upstream artifacts missing on disk");
      const [renderBytes, preBytes] = await Promise.all([
        renderBlob.arrayBuffer(),
        preBlob.arrayBuffer(),
      ]);

      const result = await splitMrc({
        renderPngBytes: renderBytes,
        preprocessedPngBytes: preBytes,
        pageIndex,
        preset: project.settings.mrc.preset,
        skewAngleDegrees: page.status.preprocess.skewAngleDegrees ?? 0,
      });

      if (isAborted(options.signal)) {
        emitProgress({
          kind: "stage",
          projectId: project.id,
          pageIndex,
          stage: "mrc",
          status: "aborted",
          ts: Date.now(),
        });
        return;
      }

      const bgExt = result.bgMimeType === "image/jpeg" ? "jpg" : "png";
      const base = `${project.id}/pages/${pageIndex}`;
      const maskPath = `${base}/mrc-mask.${hash}.png`;
      const bgPath = `${base}/mrc-bg.${hash}.${bgExt}`;
      const composedPath = `${base}/mrc-composed.${hash}.png`;
      const manifestPath = artifactPath({
        projectId: project.id,
        pageIndex,
        stage: "mrc",
        hash,
        extension: "json",
      });

      if (existing) {
        await removeFile(existing.artifactPath).catch(() => undefined);
      }

      await Promise.all([
        writeFile(maskPath, new Uint8Array(result.maskPngBytes)),
        writeFile(bgPath, new Uint8Array(result.bgImageBytes)),
        writeFile(composedPath, new Uint8Array(result.composedBytes)),
      ]);

      const manifest: MrcArtifactManifest = {
        maskPath,
        bgPath,
        bgMimeType: result.bgMimeType,
        composedPath,
        width: result.width,
        height: result.height,
        bgWidth: result.bgWidth,
        bgHeight: result.bgHeight,
        maskBytes: result.maskPngBytes.byteLength,
        bgBytes: result.bgImageBytes.byteLength,
        originalBytes: result.originalBytes,
        meanAbsoluteDifference: result.meanAbsoluteDifference,
        preset: project.settings.mrc.preset,
      };
      const manifestJson = JSON.stringify(manifest);
      await writeFile(manifestPath, new TextEncoder().encode(manifestJson));

      const totalBytes = result.maskPngBytes.byteLength + result.bgImageBytes.byteLength;
      await db.pages.update(`${project.id}:${pageIndex}`, {
        status: {
          ...(page.status ?? {}),
          mrc: {
            hash,
            completedAt: Date.now(),
            artifactPath: manifestPath,
            sizeBytes: totalBytes,
          },
        },
        thumbnails: {
          ...(page.thumbnails ?? {}),
          mrc: result.composedThumbnailDataUrl,
        },
      });

      emitProgress({
        kind: "stage",
        projectId: project.id,
        pageIndex,
        stage: "mrc",
        status: "done",
        sizeBytes: totalBytes,
        thumbnail: result.composedThumbnailDataUrl,
        ts: Date.now(),
      });
    } catch (err) {
      emitProgress({
        kind: "stage",
        projectId: project.id,
        pageIndex,
        stage: "mrc",
        status: "failed",
        error: (err as Error).message,
        ts: Date.now(),
      });
      throw err;
    }
  }
}

export async function readMrcManifest(
  projectId: string,
  pageIndex: number,
): Promise<MrcArtifactManifest | null> {
  const db = getDb();
  const page = await db.pages.get(`${projectId}:${pageIndex}`);
  if (!page?.status?.mrc) return null;
  const blob = await readBlob(page.status.mrc.artifactPath);
  if (!blob) return null;
  return JSON.parse(await blob.text());
}
