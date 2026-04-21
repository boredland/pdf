import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getDb, type Page, type Project, type Stage } from "~/lib/storage/db";
import { readBlob } from "~/lib/storage/opfs";
import { readOcrResult } from "~/lib/pipeline/ocr-pipeline";
import { runStage, runFromStage } from "~/lib/pipeline/run-stage";
import { setPageRotationOverride } from "~/lib/pipeline/rewind";

type TabId = "render" | "preprocess" | "detect" | "ocr";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "render", label: "Render" },
  { id: "preprocess", label: "Preprocess" },
  { id: "detect", label: "Detect" },
  { id: "ocr", label: "OCR" },
];

interface Props {
  project: Project;
  pageIndex: number;
  onClose: () => void;
}

export function PageDetailPane({ project, pageIndex, onClose }: Props) {
  const [tab, setTab] = useState<TabId>("render");
  const [busyStage, setBusyStage] = useState<Stage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const page = useLiveQuery<Page | undefined>(
    () => getDb().pages.get(`${project.id}:${pageIndex}`),
    [project.id, pageIndex],
  );

  // Escape closes the pane so the keyboard flow mirrors the modal dialogs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function onRerun(stage: Exclude<Stage, "build">) {
    if (!page) return;
    setBusyStage(stage);
    setError(null);
    try {
      const fresh = await getDb().projects.get(project.id);
      if (!fresh) throw new Error("project vanished");
      await runStage(fresh, stage, { pageIndices: [pageIndex] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyStage(null);
    }
  }

  if (!page) {
    return (
      <aside
        data-testid="detail-pane"
        className="fixed inset-y-0 right-0 z-30 flex w-full max-w-3xl flex-col border-l border-slate-800 bg-slate-950 shadow-2xl"
      >
        <DetailHeader title={`Page ${pageIndex + 1}`} onClose={onClose} />
        <div className="p-6 text-sm text-slate-400">loading…</div>
      </aside>
    );
  }

  return (
    <aside
      data-testid="detail-pane"
      className="fixed inset-y-0 right-0 z-30 flex w-full max-w-3xl flex-col border-l border-slate-800 bg-slate-950 shadow-2xl"
    >
      <DetailHeader
        title={`Page ${pageIndex + 1} of ${project.pageCount}`}
        onClose={onClose}
      />
      <nav className="flex items-center gap-1 border-b border-slate-800 px-2" role="tablist">
        {TABS.map((t) => {
          const status = page.status[t.id];
          return (
            <button
              key={t.id}
              role="tab"
              type="button"
              data-testid={`detail-tab-${t.id}`}
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-3 py-2 text-xs font-medium transition ${
                tab === t.id
                  ? "border-b-2 border-sky-400 text-slate-100"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <span>{t.label}</span>
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  status ? "bg-emerald-400" : "bg-slate-700"
                }`}
                aria-label={status ? "complete" : "pending"}
              />
            </button>
          );
        })}
      </nav>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
        <StageControls
          tab={tab}
          busyStage={busyStage}
          onRerun={onRerun}
          ready={!!page.status[tab]}
        />
        {error && (
          <p className="text-xs text-red-300" data-testid="detail-error">
            {error}
          </p>
        )}
        <StageContent project={project} page={page} tab={tab} />
      </div>
    </aside>
  );
}

function DetailHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
      <h2 className="text-sm font-semibold" data-testid="detail-title">
        {title}
      </h2>
      <button
        type="button"
        onClick={onClose}
        data-testid="detail-close"
        className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
      >
        Close
      </button>
    </header>
  );
}

function StageControls({
  tab,
  busyStage,
  onRerun,
  ready,
}: {
  tab: TabId;
  busyStage: Stage | null;
  onRerun: (stage: Exclude<Stage, "build">) => void;
  ready: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-xs text-slate-400">
      <span>
        {ready ? "artifact ready" : "no artifact yet"}
        {busyStage === tab ? " · running" : null}
      </span>
      <button
        type="button"
        onClick={() => onRerun(tab)}
        disabled={!!busyStage}
        data-testid={`detail-rerun-${tab}`}
        className="rounded border border-slate-700 px-3 py-1 text-slate-200 hover:bg-slate-800 disabled:opacity-60"
      >
        Re-run this stage for this page
      </button>
    </div>
  );
}

function StageContent({
  project,
  page,
  tab,
}: {
  project: Project;
  page: Page;
  tab: TabId;
}) {
  switch (tab) {
    case "render":
      return <ImageArtifact path={page.status.render?.artifactPath} />;
    case "preprocess":
      return (
        <div className="space-y-2">
          <RotationControls project={project} page={page} />
          <ImageArtifact path={page.status.preprocess?.artifactPath} />
        </div>
      );
    case "detect":
      return <DetectView project={project} page={page} />;
    case "ocr":
      return <OcrView project={project} page={page} />;
  }
}

function RotationControls({ project, page }: { project: Project; page: Page }) {
  const [busy, setBusy] = useState(false);
  const appliedAngle = page.status.preprocess?.osdAngleDegrees ?? 0;
  const override = page.rotationOverride;

  async function apply(angle: 0 | 90 | 180 | 270 | null) {
    if (busy) return;
    setBusy(true);
    try {
      await setPageRotationOverride(project.id, page.index, angle);
      // Re-run preprocess through build for just this page. Build reuses
      // all other pages' cached artifacts.
      const fresh = await getDb().projects.get(project.id);
      if (fresh) {
        await runFromStage(fresh, "preprocess", { pageIndices: [page.index] });
        // Rebuild the project-wide PDF.
        await runStage(fresh, "build");
      }
    } finally {
      setBusy(false);
    }
  }

  const options: Array<{ angle: 0 | 90 | 180 | 270; label: string }> = [
    { angle: 0, label: "0°" },
    { angle: 90, label: "90°" },
    { angle: 180, label: "180°" },
    { angle: 270, label: "270°" },
  ];

  return (
    <div
      data-testid="detail-rotation-controls"
      className="flex flex-wrap items-center gap-2 rounded border border-slate-800 bg-slate-900/60 p-2 text-xs"
    >
      <span className="text-slate-400">
        Applied: <span data-testid="detail-rotation-applied">{appliedAngle}°</span>
        {override !== undefined && (
          <span className="ml-1 rounded bg-amber-500/20 px-1 text-amber-300">
            manual
          </span>
        )}
      </span>
      <div className="flex gap-1">
        {options.map((o) => {
          const isActive = override === o.angle;
          return (
            <button
              key={o.angle}
              type="button"
              disabled={busy}
              onClick={() => void apply(o.angle)}
              data-testid={`detail-rotate-${o.angle}`}
              className={`rounded px-2 py-1 ${
                isActive
                  ? "bg-sky-500/30 text-sky-100"
                  : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              } disabled:opacity-50`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {override !== undefined && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void apply(null)}
          data-testid="detail-rotate-revert"
          className="rounded bg-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-700 disabled:opacity-50"
          title="Revert to auto-detected rotation"
        >
          use OSD
        </button>
      )}
    </div>
  );
}

function useBlobUrl(path: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      if (!path) {
        setUrl(null);
        return;
      }
      const blob = await readBlob(path);
      if (!blob || cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  return url;
}

function ImageArtifact({
  path,
  testId = "detail-image",
}: {
  path: string | undefined;
  testId?: string;
}) {
  const url = useBlobUrl(path);
  if (!path) return <EmptyState label="Run this stage to produce an artifact." />;
  if (!url) return <EmptyState label="loading…" />;
  return (
    <div className="overflow-auto rounded border border-slate-800 bg-slate-900">
      <img src={url} alt="stage artifact" data-testid={testId} className="mx-auto block" />
    </div>
  );
}

function DetectView({ project, page }: { project: Project; page: Page }) {
  const overlayPath = page.status.detect?.overlayPath ?? page.status.render?.artifactPath;
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">
        Overlay image shows detected text-region bounding boxes drawn on the original page.
      </p>
      <ImageArtifact path={overlayPath} testId="detail-image" />
      <DetectJson project={project} page={page} />
    </div>
  );
}

function DetectJson({ project, page }: { project: Project; page: Page }) {
  const [regions, setRegions] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!page.status.detect) return;
      const blob = await readBlob(page.status.detect.artifactPath);
      if (!blob || cancelled) return;
      const json = JSON.parse(await blob.text());
      setRegions(Array.isArray(json.regions) ? json.regions.length : 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [page.status.detect?.artifactPath, project.id]);
  if (regions === null) return null;
  return (
    <p className="text-xs text-slate-400" data-testid="detail-detect-count">
      {regions} region{regions === 1 ? "" : "s"} detected.
    </p>
  );
}

function OcrView({ project, page }: { project: Project; page: Page }) {
  const [text, setText] = useState<string | null>(null);
  const [wordCount, setWordCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await readOcrResult(project.id, page.index);
      if (cancelled) return;
      if (!result) {
        setText(null);
        setWordCount(0);
        return;
      }
      setText(result.text);
      setWordCount(result.words.length);
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id, page.index, page.status.ocr?.hash]);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-2">
        <ImageArtifact path={page.status.preprocess?.artifactPath} />
        <div className="flex flex-col gap-2 rounded border border-slate-800 bg-slate-900 p-3">
          <p className="text-xs text-slate-400" data-testid="detail-ocr-meta">
            {wordCount} word{wordCount === 1 ? "" : "s"}
          </p>
          <pre
            data-testid="detail-ocr-text"
            className="whitespace-pre-wrap break-words text-xs text-slate-200"
          >
            {text ?? "No OCR artifact yet. Re-run this stage."}
          </pre>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded border border-dashed border-slate-700 p-8 text-center text-xs text-slate-400">
      {label}
    </div>
  );
}
