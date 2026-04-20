import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getDb, type Page, type Project, type Stage } from "~/lib/storage/db";
import { readBlob } from "~/lib/storage/opfs";
import { readOcrResult } from "~/lib/pipeline/ocr-pipeline";
import { readMrcManifest } from "~/lib/pipeline/mrc-pipeline";
import { runStage } from "~/lib/pipeline/run-stage";

type TabId = "render" | "preprocess" | "detect" | "ocr" | "mrc";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "render", label: "Render" },
  { id: "preprocess", label: "Preprocess" },
  { id: "detect", label: "Detect" },
  { id: "ocr", label: "OCR" },
  { id: "mrc", label: "MRC" },
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
    case "preprocess":
      return <ImageArtifact path={page.status[tab]?.artifactPath} />;
    case "detect":
      return <DetectView project={project} page={page} />;
    case "ocr":
      return <OcrView project={project} page={page} />;
    case "mrc":
      return <MrcView project={project} page={page} />;
  }
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
      <p className="text-xs text-slate-500">
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

function MrcView({ project, page }: { project: Project; page: Page }) {
  const [manifest, setManifest] = useState<Awaited<
    ReturnType<typeof readMrcManifest>
  > | null>(null);
  const [layer, setLayer] = useState<"mask" | "bg" | "composed">("composed");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const m = await readMrcManifest(project.id, page.index);
      if (!cancelled) setManifest(m);
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id, page.index, page.status.mrc?.hash]);

  const path = useMemo(() => {
    if (!manifest) return undefined;
    return layer === "mask"
      ? manifest.maskPath
      : layer === "bg"
        ? manifest.bgPath
        : manifest.composedPath;
  }, [manifest, layer]);

  if (!manifest) {
    return <EmptyState label="Run MRC to produce mask/background/composed layers." />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1" role="tablist">
        {(["mask", "bg", "composed"] as const).map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={layer === id}
            data-testid={`detail-mrc-layer-${id}`}
            onClick={() => setLayer(id)}
            className={`rounded px-3 py-1 text-xs ${
              layer === id
                ? "bg-sky-500/20 text-sky-200"
                : "border border-slate-700 text-slate-300 hover:bg-slate-800"
            }`}
          >
            {id === "bg" ? "Background" : id === "mask" ? "Mask" : "Composed"}
          </button>
        ))}
      </div>
      <dl
        className="grid grid-cols-3 gap-2 text-xs text-slate-400"
        data-testid="detail-mrc-stats"
      >
        <Stat label="Mask" value={`${Math.round(manifest.maskBytes / 1024)} KB`} />
        <Stat label="Background" value={`${Math.round(manifest.bgBytes / 1024)} KB`} />
        <Stat
          label="Round-trip MAD"
          value={manifest.meanAbsoluteDifference.toFixed(1)}
        />
      </dl>
      <ImageArtifact path={path} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="uppercase tracking-wide text-[10px] text-slate-500">{label}</dt>
      <dd className="text-slate-200">{value}</dd>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded border border-dashed border-slate-700 p-8 text-center text-xs text-slate-500">
      {label}
    </div>
  );
}
