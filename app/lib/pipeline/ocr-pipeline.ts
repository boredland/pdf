import { artifactPath, settingsHash } from "~/lib/artifacts";
import { emitProgress } from "~/lib/progress";
import { getProvider } from "~/lib/providers/registry";
import { getDb, type Project } from "~/lib/storage/db";
import { readBlob, removeFile, writeFile } from "~/lib/storage/opfs";

export interface OcrPipelineOptions {
  signal?: AbortSignal;
  pageIndices?: number[];
}

function isAborted(signal?: AbortSignal) {
  return signal?.aborted ?? false;
}

export async function runOcrPipeline(
  project: Project,
  options: OcrPipelineOptions = {},
): Promise<void> {
  const db = getDb();
  const hash = await settingsHash(project.settings, "ocr");
  const provider = getProvider(project.settings.ocr.providerId);
  const targetIndices = options.pageIndices ?? [
    ...Array.from({ length: project.pageCount }, (_, i) => i),
  ];

  for (const pageIndex of targetIndices) {
    if (isAborted(options.signal)) {
      emitProgress({
        kind: "stage",
        projectId: project.id,
        pageIndex,
        stage: "ocr",
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
        stage: "ocr",
        status: "failed",
        error: "no preprocess artifact",
        ts: Date.now(),
      });
      continue;
    }

    const existing = page.status.ocr;
    if (existing && existing.hash === hash) {
      const blob = await readBlob(existing.artifactPath);
      if (blob) {
        emitProgress({
          kind: "stage",
          projectId: project.id,
          pageIndex,
          stage: "ocr",
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
      stage: "ocr",
      status: "running",
      ts: Date.now(),
    });

    try {
      const preBlob = await readBlob(page.status.preprocess.artifactPath);
      if (!preBlob) throw new Error("preprocess artifact missing");
      const pngBytes = await preBlob.arrayBuffer();
      const result = await provider.recognize({
        pngBytes,
        pageIndex,
        language: project.settings.ocr.language,
        signal: options.signal,
      });

      if (isAborted(options.signal)) {
        emitProgress({
          kind: "stage",
          projectId: project.id,
          pageIndex,
          stage: "ocr",
          status: "aborted",
          ts: Date.now(),
        });
        return;
      }

      if (existing) await removeFile(existing.artifactPath).catch(() => undefined);

      const path = artifactPath({
        projectId: project.id,
        pageIndex,
        stage: "ocr",
        hash,
        extension: "json",
      });
      const payload = JSON.stringify(result);
      await writeFile(path, new TextEncoder().encode(payload));

      await db.pages.update(`${project.id}:${pageIndex}`, {
        status: {
          ...(page.status ?? {}),
          ocr: {
            hash,
            completedAt: Date.now(),
            artifactPath: path,
            sizeBytes: payload.length,
          },
        },
        // OCR has no visual artifact; reuse the preprocess thumbnail so the
        // card's ocr-slot shows something while expanding to a text modal.
        thumbnails: {
          ...(page.thumbnails ?? {}),
          ocr: page.thumbnails?.preprocess ?? page.thumbnailDataUrl ?? undefined,
        },
      });

      emitProgress({
        kind: "stage",
        projectId: project.id,
        pageIndex,
        stage: "ocr",
        status: "done",
        thumbnail: page.thumbnailDataUrl,
        sizeBytes: payload.length,
        ts: Date.now(),
      });
    } catch (err) {
      emitProgress({
        kind: "stage",
        projectId: project.id,
        pageIndex,
        stage: "ocr",
        status: "failed",
        error: (err as Error).message,
        ts: Date.now(),
      });
      throw err;
    }
  }
}

export async function readOcrResult(
  projectId: string,
  pageIndex: number,
): Promise<import("~/lib/providers/types").OcrResult | null> {
  const db = getDb();
  const page = await db.pages.get(`${projectId}:${pageIndex}`);
  if (!page?.status?.ocr) return null;
  const blob = await readBlob(page.status.ocr.artifactPath);
  if (!blob) return null;
  return JSON.parse(await blob.text());
}
