import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getDb, type Page, type Project } from "~/lib/storage/db";
import { createProjectFromBytes, removePage } from "~/lib/projects";
import { runRenderPipeline, ensurePageRows } from "~/lib/pipeline/render-pipeline";
import { runPreprocessPipeline } from "~/lib/pipeline/preprocess-pipeline";
import { runDetectPipeline } from "~/lib/pipeline/detect-pipeline";
import { runOcrPipeline } from "~/lib/pipeline/ocr-pipeline";
import { runMrcPipeline } from "~/lib/pipeline/mrc-pipeline";
import { runBuildPipeline, readBuildOutput } from "~/lib/pipeline/build-pipeline";
import { exportProjectAlto, exportProjectHocr } from "~/lib/export/export-hocr";
import { PIPELINE_ORDER, runStage } from "~/lib/pipeline/run-stage";
import { rewindToStage } from "~/lib/pipeline/rewind";
import { PageDetailPane } from "~/components/page-detail-pane";
import type { Stage } from "~/lib/storage/db";
import { progressChannel, type ProgressEvent } from "~/lib/progress";
import { EXAMPLE_PDFS, loadExamplePdf, type ExampleId } from "~/lib/examples";
import { SettingsPanel } from "~/components/settings-panel";
import { ApiKeysPanel } from "~/components/api-keys-panel";
import { LanguagesPanel } from "~/components/languages-panel";
import { StageStrip } from "~/components/stage-strip";
import { JobProgress } from "~/components/job-progress";
import { computeProgress } from "~/lib/project-progress";

export function ProjectView() {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stageToRun, setStageToRun] = useState<"all" | Exclude<Stage, "build">>("all");
  const [openPageIndex, setOpenPageIndex] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const project = useLiveQuery<Project | undefined>(
    async () => (activeProjectId ? getDb().projects.get(activeProjectId) : undefined),
    [activeProjectId],
  );

  const pages = useLiveQuery<Page[]>(
    async () =>
      activeProjectId
        ? getDb()
            .pages.where({ projectId: activeProjectId })
            .sortBy("index")
        : [],
    [activeProjectId],
  );

  const runningStages = useProgressMap(activeProjectId);

  const ingest = useCallback(async (name: string, bytes: ArrayBuffer, mimeType?: string) => {
    // Project creation only: we deliberately don't auto-run the pipeline.
    // The user should review settings (languages, OCR provider, MRC preset,
    // preprocess toggles) *before* anything kicks off — pipelines run only
    // once they click the Run button.
    setError(null);
    setIsBusy(true);
    try {
      const next = await createProjectFromBytes(name, bytes, mimeType);
      setActiveProjectId(next.id);
      await ensurePageRows(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsBusy(false);
    }
  }, []);

  const onFileDrop = useCallback(
    async (file: File) => {
      const bytes = await file.arrayBuffer();
      await ingest(file.name, bytes, file.type);
    },
    [ingest],
  );

  const onLoadExample = useCallback(
    async (id: ExampleId) => {
      const bytes = await loadExamplePdf(id);
      await ingest(EXAMPLE_PDFS[id].name, bytes);
    },
    [ingest],
  );

  const onAbort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const onReprocess = useCallback(async () => {
    if (!project) return;
    setError(null);
    setIsBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await rewindToStage(project.id, "preprocess");
      await runPreprocessPipeline(project, { signal: controller.signal });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsBusy(false);
      abortRef.current = null;
    }
  }, [project]);

  const onRunStage = useCallback(async () => {
    if (!project) return;
    setError(null);
    setIsBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      if (stageToRun === "all") {
        await runRenderPipeline(project, { signal: controller.signal });
        if (controller.signal.aborted) return;
        await runPreprocessPipeline(project, { signal: controller.signal });
        if (controller.signal.aborted) return;
        await runDetectPipeline(project, { signal: controller.signal });
        if (controller.signal.aborted) return;
        await runOcrPipeline(project, { signal: controller.signal });
        if (controller.signal.aborted) return;
        await runMrcPipeline(project, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const fresh = await getDb().projects.get(project.id);
        if (fresh) await runBuildPipeline(fresh, { signal: controller.signal });
      } else {
        await runStage(project, stageToRun, { signal: controller.signal });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsBusy(false);
      abortRef.current = null;
    }
  }, [project, stageToRun]);

  const onDownload = useCallback(async () => {
    if (!project?.build) return;
    const blob = await readBuildOutput(project.id);
    if (!blob) return;
    triggerDownload(blob, `${safeFileName(project.name)}.pdf`);
  }, [project]);

  const onDownloadHocr = useCallback(async () => {
    if (!project) return;
    const blob = await exportProjectHocr(project);
    if (!blob) {
      setError("No OCR results to export — run OCR first.");
      return;
    }
    triggerDownload(blob, `${safeFileName(project.name)}.hocr.html`);
  }, [project]);

  const onDownloadAlto = useCallback(async () => {
    if (!project) return;
    const blob = await exportProjectAlto(project);
    if (!blob) {
      setError("No OCR results to export — run OCR first.");
      return;
    }
    triggerDownload(blob, `${safeFileName(project.name)}.alto.xml`);
  }, [project]);

  const pageList = pages ?? [];

  return (
    <div className="space-y-6" data-testid="project-view">
      <DropZone
        dragging={dragging}
        onDragChange={setDragging}
        onFile={(file) => void onFileDrop(file)}
        onLoadExample={(id) => void onLoadExample(id)}
        disabled={isBusy}
      />
      <ApiKeysPanel />
      {error && (
        <p className="text-sm text-red-400" data-testid="project-error">
          {error}
        </p>
      )}
      {project && (
        <section className="space-y-3" data-testid="project-section">
          <header className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold" data-testid="project-name">
                {project.name}
              </h2>
              <p className="text-xs text-slate-400" data-testid="project-meta">
                {project.pageCount} page{project.pageCount === 1 ? "" : "s"} · {project.id}
              </p>
              <SizeDelta project={project} />
            </div>
            <div className="flex items-center gap-2">
              {!isBusy && (
                <>
                  <select
                    value={stageToRun}
                    onChange={(e) =>
                      setStageToRun(
                        e.target.value as "all" | Exclude<Stage, "build">,
                      )
                    }
                    data-testid="stage-picker"
                    className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-200"
                  >
                    <option value="all">Full pipeline</option>
                    {PIPELINE_ORDER.map((s) => (
                      <option key={s} value={s}>
                        Only {s}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void onRunStage()}
                    data-testid="run-stage-button"
                    data-run-label={getRunLabel(project, pageList)}
                    className="rounded-md bg-sky-500/20 px-3 py-1.5 text-sm font-medium text-sky-200 hover:bg-sky-500/30"
                  >
                    {getRunLabel(project, pageList)}
                  </button>
                  {project.build && (
                    <button
                      type="button"
                      onClick={() => void onDownload()}
                      data-testid="download-pdf"
                      className="rounded-md bg-emerald-500/20 px-3 py-1.5 text-sm font-medium text-emerald-200 hover:bg-emerald-500/30"
                      title={`Searchable PDF · ${Math.round((project.build.sizeBytes ?? 0) / 1024)} KB`}
                    >
                      Download PDF
                    </button>
                  )}
                  {pageList.some((p) => p.status.ocr) && (
                    <>
                      <button
                        type="button"
                        onClick={() => void onDownloadHocr()}
                        data-testid="download-hocr"
                        className="rounded-md border border-emerald-500/40 px-3 py-1.5 text-sm font-medium text-emerald-200 hover:bg-emerald-500/10"
                        title="Structured OCR output (hOCR / XHTML)"
                      >
                        Download hOCR
                      </button>
                      <button
                        type="button"
                        onClick={() => void onDownloadAlto()}
                        data-testid="download-alto"
                        className="rounded-md border border-emerald-500/40 px-3 py-1.5 text-sm font-medium text-emerald-200 hover:bg-emerald-500/10"
                        title="Structured OCR output (ALTO 4.1 XML)"
                      >
                        Download ALTO
                      </button>
                    </>
                  )}
                </>
              )}
              {isBusy && (
                <button
                  type="button"
                  onClick={onAbort}
                  data-testid="abort-button"
                  className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1 text-sm text-red-300 hover:bg-red-500/20"
                >
                  Abort
                </button>
              )}
            </div>
          </header>
          <JobProgress project={project} />
          <SettingsPanel project={project} disabled={isBusy} />
          <LanguagesPanel project={project} disabled={isBusy} />
          <PageGrid
            pages={pageList}
            running={runningStages}
            onOpen={(idx) => setOpenPageIndex(idx)}
            onRemove={async (idx) => {
              if (!project) return;
              if (
                !window.confirm(
                  `Remove page ${idx + 1}? This drops its artifacts and invalidates the built PDF.`,
                )
              ) {
                return;
              }
              await removePage(project.id, idx);
            }}
          />
          {openPageIndex !== null && (
            <PageDetailPane
              project={project}
              pageIndex={openPageIndex}
              onClose={() => setOpenPageIndex(null)}
            />
          )}
        </section>
      )}
    </div>
  );
}

function safeFileName(name: string): string {
  return name.replace(/[^\w.-]+/g, "_") || "output";
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SizeDelta({ project }: { project: Project }) {
  const source = project.sourceSizeBytes;
  const built = project.build?.sizeBytes;
  if (!source || !built) return null;
  const deltaPct = ((built - source) / source) * 100;
  const rounded = Math.round(deltaPct);
  const sign = rounded >= 0 ? "+" : "";
  const tone =
    rounded <= -5
      ? "text-emerald-400"
      : rounded >= 5
        ? "text-amber-400"
        : "text-slate-400";
  return (
    <p
      className={`text-xs ${tone}`}
      data-testid="project-size-delta"
      data-size-delta-percent={rounded}
    >
      {formatBytes(source)} → {formatBytes(built)} ({sign}
      {rounded}%)
    </p>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getRunLabel(project: Project | undefined, pages: Page[]): string {
  if (!project) return "Run";
  const progress = computeProgress(project, pages);
  if (progress.built) return "Re-run";
  if (progress.partial) return "Resume";
  return "Run";
}

function DropZone(props: {
  dragging: boolean;
  onDragChange: (v: boolean) => void;
  onFile: (f: File) => void;
  onLoadExample: (id: ExampleId) => void;
  disabled: boolean;
}) {
  const { dragging, onDragChange, onFile, onLoadExample, disabled } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      data-testid="drop-zone"
      onDragOver={(e) => {
        e.preventDefault();
        onDragChange(true);
      }}
      onDragLeave={() => onDragChange(false)}
      onDrop={(e) => {
        e.preventDefault();
        onDragChange(false);
        const file = e.dataTransfer.files[0];
        if (file) onFile(file);
      }}
      className={`flex flex-col items-center gap-3 rounded-lg border border-dashed p-10 text-center transition ${
        dragging ? "border-sky-400 bg-sky-500/10" : "border-slate-700 bg-slate-900/40"
      } ${disabled ? "opacity-60" : ""}`}
    >
      <p className="text-slate-300">
        Drop a PDF here, or{" "}
        <button
          type="button"
          className="underline decoration-dotted hover:text-slate-100"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
        >
          pick a file
        </button>
        .
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="load-example"
          disabled={disabled}
          onClick={() => onLoadExample("scanned")}
          className="rounded-md bg-sky-500/20 px-3 py-1.5 text-sm text-sky-200 hover:bg-sky-500/30 disabled:opacity-60"
          title={EXAMPLE_PDFS.scanned.description}
        >
          Load scanned example
        </button>
        <button
          type="button"
          data-testid="load-example-cardinal"
          disabled={disabled}
          onClick={() => onLoadExample("cardinal")}
          className="rounded-md bg-sky-500/20 px-3 py-1.5 text-sm text-sky-200 hover:bg-sky-500/30 disabled:opacity-60"
          title={EXAMPLE_PDFS.cardinal.description}
        >
          Load cardinal example
        </button>
        <button
          type="button"
          data-testid="load-example-synthetic"
          disabled={disabled}
          onClick={() => onLoadExample("synthetic")}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-60"
          title={EXAMPLE_PDFS.synthetic.description}
        >
          Synthetic fallback
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        data-testid="file-input"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function PageGrid({
  pages,
  running,
  onOpen,
  onRemove,
}: {
  pages: Page[];
  running: Map<number, ProgressEvent>;
  onOpen: (index: number) => void;
  onRemove: (index: number) => void | Promise<void>;
}) {
  if (pages.length === 0) {
    return (
      <p className="text-sm text-slate-400" data-testid="pages-empty">
        No pages yet. Loading…
      </p>
    );
  }
  return (
    <ul
      className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
      data-testid="page-grid"
    >
      {pages.map((page, displayIndex) => {
        const runtime = running.get(page.index);
        const status =
          runtime?.kind === "stage" && runtime.stage === "render"
            ? runtime.status
            : page.status.render
              ? "done"
              : "queued";
        return (
          <li
            key={page.id}
            data-testid={`page-card-${page.index}`}
            data-display-index={displayIndex}
            data-page-status={status}
            data-render-status={page.status.render ? "done" : "pending"}
            data-preprocess-status={page.status.preprocess ? "done" : "pending"}
            data-detect-status={page.status.detect ? "done" : "pending"}
            data-ocr-status={page.status.ocr ? "done" : "pending"}
            data-mrc-status={page.status.mrc ? "done" : "pending"}
            className="rounded-md border border-slate-800 bg-slate-900/60 p-2"
          >
            <button
              type="button"
              onClick={() => onOpen(page.index)}
              data-testid={`page-open-${page.index}`}
              className="block w-full text-left"
            >
              <div className="aspect-[3/4] overflow-hidden rounded bg-slate-800/60">
                {page.thumbnailDataUrl ? (
                  <img
                    src={page.thumbnailDataUrl}
                    alt={`page ${page.index + 1}`}
                    className="h-full w-full object-contain"
                    data-testid={`page-thumb-${page.index}`}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-[10px] text-slate-400">
                    {status === "running" ? "rendering…" : "queued"}
                  </div>
                )}
              </div>
              <p className="mt-1 text-center text-[10px] text-slate-400">
                page {displayIndex + 1} · {status}
              </p>
            </button>
            <button
              type="button"
              onClick={() => void onRemove(page.index)}
              data-testid={`page-remove-${page.index}`}
              className="mt-1 w-full rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400 hover:bg-red-500/20 hover:text-red-300"
              title="Remove this page from the project"
            >
              remove
            </button>
            <details className="group mt-1" data-testid={`page-details-${page.index}`}>
              <summary
                data-testid={`page-details-summary-${page.index}`}
                className="cursor-pointer list-none text-[10px] text-slate-400 hover:text-slate-300"
              >
                <span className="group-open:hidden">▸ show all stages</span>
                <span className="hidden group-open:inline">▾ hide stages</span>
              </summary>
              <StageStrip page={page} />
            </details>
          </li>
        );
      })}
    </ul>
  );
}

function useProgressMap(projectId: string | null) {
  const [map, setMap] = useState<Map<number, ProgressEvent>>(new Map());
  const channelMemo = useMemo(() => progressChannel(), []);
  useEffect(() => {
    if (!projectId) return () => channelMemo.close();
    const handler = (event: MessageEvent<ProgressEvent>) => {
      const data = event.data;
      if (data.kind !== "stage" || data.projectId !== projectId) return;
      setMap((prev) => {
        const next = new Map(prev);
        next.set(data.pageIndex, data);
        return next;
      });
    };
    channelMemo.addEventListener("message", handler);
    return () => {
      channelMemo.removeEventListener("message", handler);
    };
  }, [channelMemo, projectId]);
  useEffect(() => () => channelMemo.close(), [channelMemo]);
  return map;
}
