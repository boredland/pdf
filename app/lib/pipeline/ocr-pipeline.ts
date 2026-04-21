import { artifactPath, settingsHash } from "~/lib/artifacts";
import { emitProgress } from "~/lib/progress";
import { getProvider } from "~/lib/providers/registry";
import type { OcrResult } from "~/lib/providers/types";
import { readDetectRegions } from "~/lib/pipeline/detect-pipeline";
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

      // Hosted providers (Gemini, Mistral, ...) return flat text without
      // per-word bboxes. If the detect stage found MSER regions we can
      // crop to each and recall the provider per-region, turning each
      // region's pixel bbox into the resulting text's coordinates — so
      // hOCR/ALTO exports from hosted OCR line up with the source page.
      // Tesseract already emits real word bboxes on the full page, so we
      // skip the crop loop for it.
      let result: OcrResult;
      if (provider.kind === "hosted") {
        result = await runHostedOcrPerRegion({
          provider,
          projectId: project.id,
          pageIndex,
          language: project.settings.ocr.language,
          pngBytes,
          signal: options.signal,
        });
      } else {
        result = await provider.recognize({
          pngBytes,
          pageIndex,
          language: project.settings.ocr.language,
          signal: options.signal,
        });
      }

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

interface HostedOcrArgs {
  provider: import("~/lib/providers/types").OcrProvider;
  projectId: string;
  pageIndex: number;
  language: string;
  pngBytes: ArrayBuffer;
  signal?: AbortSignal;
}

/**
 * For hosted OCR providers (Gemini, Mistral), crop the preprocessed page
 * into the MSER-detected regions and dispatch one provider call per
 * region. Each region's pixel rectangle becomes the line bbox, so the
 * exported hOCR/ALTO is pixel-accurate instead of carrying evenly-
 * stepped placeholder rectangles. Falls back to a single full-page call
 * when detect artifacts aren't available.
 */
async function runHostedOcrPerRegion(args: HostedOcrArgs): Promise<OcrResult> {
  const {
    provider,
    projectId,
    pageIndex,
    language,
    pngBytes,
    signal,
  } = args;

  const detect = await readDetectRegions(projectId, pageIndex);
  if (!detect || detect.regions.length === 0) {
    return provider.recognize({ pngBytes, pageIndex, language, signal });
  }

  // Decode the page into a canvas once so we can crop cheaply.
  const blob = new Blob([pngBytes], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  const pageSize = { width: bitmap.width, height: bitmap.height };

  const combined: OcrResult = {
    providerId: provider.id,
    pageSize,
    text: "",
    hocr: "",
    words: [],
    lines: [],
  };

  for (const region of detect.regions) {
    if (signal?.aborted) break;
    const crop = new OffscreenCanvas(region.width, region.height);
    const ctx = crop.getContext("2d");
    if (!ctx) continue;
    ctx.drawImage(
      bitmap,
      region.x,
      region.y,
      region.width,
      region.height,
      0,
      0,
      region.width,
      region.height,
    );
    const cropBlob = await crop.convertToBlob({ type: "image/png" });
    const cropBytes = await cropBlob.arrayBuffer();
    const regionResult = await provider.recognize({
      pngBytes: cropBytes,
      pageIndex,
      language,
      signal,
    });

    // Offset every bbox back into page coordinates.
    const regionWords = regionResult.words.map((w) => ({
      ...w,
      bbox: {
        x: w.bbox.x + region.x,
        y: w.bbox.y + region.y,
        width: w.bbox.width,
        height: w.bbox.height,
      },
    }));
    combined.words.push(...regionWords);
    combined.lines.push({
      text: regionResult.text.trim(),
      bbox: region,
      words: regionWords,
    });
    combined.text = combined.text
      ? `${combined.text}\n${regionResult.text.trim()}`
      : regionResult.text.trim();
  }

  bitmap.close?.();
  return combined;
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
