import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getDb, type Project } from "~/lib/storage/db";
import { computeProgress } from "~/lib/project-progress";
import { progressChannel, type ProgressEvent } from "~/lib/progress";

interface FailureEntry {
  key: string;
  pageIndex: number;
  stage: string;
  error: string;
  ts: number;
}

const MAX_FAILURES_VISIBLE = 3;

export function JobProgress({ project }: { project: Project }) {
  const pages =
    useLiveQuery(
      () => getDb().pages.where({ projectId: project.id }).sortBy("index"),
      [project.id],
    ) ?? [];

  const progress = computeProgress(project, pages);
  const percent = Math.round(progress.ratio * 100);

  const [failures, setFailures] = useState<FailureEntry[]>([]);
  const channel = useMemo(() => progressChannel(), []);
  useEffect(() => {
    const handler = (event: MessageEvent<ProgressEvent>) => {
      const data = event.data;
      if (data.kind !== "stage") return;
      if (data.projectId !== project.id) return;
      if (data.status !== "failed") return;
      setFailures((prev) => {
        const entry: FailureEntry = {
          key: `${data.stage}-${data.pageIndex}-${data.ts}`,
          pageIndex: data.pageIndex,
          stage: data.stage,
          error: data.error ?? "unknown error",
          ts: data.ts,
        };
        // Same stage+page keeps only the most recent error so a retry
        // doesn't stack duplicates.
        const dedup = prev.filter(
          (p) => !(p.stage === entry.stage && p.pageIndex === entry.pageIndex),
        );
        return [entry, ...dedup].slice(0, MAX_FAILURES_VISIBLE);
      });
    };
    channel.addEventListener("message", handler);
    return () => channel.removeEventListener("message", handler);
  }, [channel, project.id]);
  useEffect(() => () => channel.close(), [channel]);

  // Clear displayed failures once the project completes end-to-end — the
  // user has obviously moved past the failure state.
  useEffect(() => {
    if (progress.built) setFailures([]);
  }, [progress.built]);

  return (
    <div
      data-testid="job-progress"
      data-progress-percent={percent}
      data-progress-ratio={progress.ratio.toFixed(3)}
      data-partial={progress.partial ? "true" : "false"}
      data-built={progress.built ? "true" : "false"}
      data-earliest-missing={progress.earliestMissingStage ?? "none"}
      data-failure-count={failures.length}
      className="space-y-1"
    >
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-slate-500">
        <span>
          {progress.stagesDone} / {progress.stagesTotal} steps
        </span>
        <span className="tabular-nums">{percent}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-slate-800">
        <div
          className={`h-full transition-[width] duration-200 ${
            progress.built
              ? "bg-emerald-400"
              : progress.partial
                ? "bg-sky-400"
                : "bg-slate-600"
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {failures.length > 0 && (
        <ul
          data-testid="job-progress-failures"
          className="space-y-1 pt-1 text-[11px]"
        >
          {failures.map((f) => {
            const pageLabel =
              f.pageIndex < 0 ? "project" : `page ${f.pageIndex + 1}`;
            return (
              <li
                key={f.key}
                data-testid={`job-progress-failure-${f.stage}-${f.pageIndex}`}
                className="flex items-start justify-between gap-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-red-200"
              >
                <div className="min-w-0">
                  <span className="font-medium capitalize">{f.stage}</span>
                  <span className="text-red-300/80"> · {pageLabel}: </span>
                  <span className="break-words text-red-100/90">{f.error}</span>
                </div>
                <button
                  type="button"
                  data-testid={`job-progress-failure-dismiss-${f.stage}-${f.pageIndex}`}
                  onClick={() =>
                    setFailures((prev) => prev.filter((p) => p.key !== f.key))
                  }
                  className="shrink-0 text-red-300/80 hover:text-red-100"
                  aria-label="dismiss error"
                  title="Dismiss"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
