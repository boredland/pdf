import { artifactPath, settingsHash } from "~/lib/artifacts";
import { emitProgress } from "~/lib/progress";
import { writeFile, readBlob, removeFile } from "~/lib/storage/opfs";
import type { Project } from "~/lib/storage/db";
import { getDb } from "~/lib/storage/db";
import { getPageCount, renderPage } from "~/lib/workers/render-client";

export interface RenderPipelineOptions {
  signal?: AbortSignal;
  pageIndices?: number[];
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

async function readPdfBytes(project: Project): Promise<ArrayBuffer> {
  const blob = await readBlob(project.sourcePdfPath);
  if (!blob) throw new Error(`source PDF missing at ${project.sourcePdfPath}`);
  return blob.arrayBuffer();
}

export async function ensurePageRows(project: Project): Promise<void> {
  const db = getDb();
  const bytes = await readPdfBytes(project);
  const count = await getPageCount(bytes);
  if (count !== project.pageCount) {
    await db.projects.update(project.id, { pageCount: count });
  }
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      id: `${project.id}:${i}`,
      projectId: project.id,
      index: i,
      status: {},
    });
  }
  await db.pages.bulkPut(rows);
}

export async function runRenderPipeline(
  project: Project,
  options: RenderPipelineOptions = {},
): Promise<void> {
  const db = getDb();
  const hash = await settingsHash(project.settings, "render");
  const pdfBytes = await readPdfBytes(project);
  const targetIndices = options.pageIndices ?? [
    ...Array.from({ length: project.pageCount }, (_, i) => i),
  ];

  for (const pageIndex of targetIndices) {
    if (isAborted(options.signal)) {
      emitProgress({
        kind: "stage",
        projectId: project.id,
        pageIndex,
        stage: "render",
        status: "aborted",
        ts: Date.now(),
      });
      return;
    }

    const row = await db.pages.get(`${project.id}:${pageIndex}`);
    const existing = row?.status?.render;
    if (existing && existing.hash === hash) {
      const blob = await readBlob(existing.artifactPath);
      if (blob) {
        emitProgress({
          kind: "stage",
          projectId: project.id,
          pageIndex,
          stage: "render",
          status: "cached",
          thumbnail: row?.thumbnailDataUrl,
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
      stage: "render",
      status: "running",
      ts: Date.now(),
    });

    try {
      const result = await renderPage(pdfBytes, pageIndex, project.settings.render.dpi);
      if (isAborted(options.signal)) {
        emitProgress({
          kind: "stage",
          projectId: project.id,
          pageIndex,
          stage: "render",
          status: "aborted",
          ts: Date.now(),
        });
        return;
      }
      const path = artifactPath({
        projectId: project.id,
        pageIndex,
        stage: "render",
        hash,
        extension: "png",
      });
      await writeFile(path, new Uint8Array(result.pngBytes));
      await db.pages.update(`${project.id}:${pageIndex}`, {
        status: {
          ...(row?.status ?? {}),
          render: {
            hash,
            completedAt: Date.now(),
            artifactPath: path,
            sizeBytes: result.pngBytes.byteLength,
          },
        },
        thumbnailDataUrl: result.thumbnailDataUrl,
      });
      emitProgress({
        kind: "stage",
        projectId: project.id,
        pageIndex,
        stage: "render",
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
        stage: "render",
        status: "failed",
        error: (err as Error).message,
        ts: Date.now(),
      });
      throw err;
    }
  }
}

export async function dropRenderArtifacts(projectId: string): Promise<void> {
  const db = getDb();
  const pages = await db.pages.where({ projectId }).toArray();
  for (const page of pages) {
    const stage = page.status?.render;
    if (stage) await removeFile(stage.artifactPath);
    await db.pages.update(page.id, {
      status: { ...page.status, render: undefined },
      thumbnailDataUrl: undefined,
    });
  }
}
