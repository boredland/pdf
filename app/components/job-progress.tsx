import { useLiveQuery } from "dexie-react-hooks";
import { getDb, type Project } from "~/lib/storage/db";
import { computeProgress } from "~/lib/project-progress";

export function JobProgress({ project }: { project: Project }) {
  const pages =
    useLiveQuery(
      () => getDb().pages.where({ projectId: project.id }).sortBy("index"),
      [project.id],
    ) ?? [];

  const progress = computeProgress(project, pages);
  const percent = Math.round(progress.ratio * 100);

  return (
    <div
      data-testid="job-progress"
      data-progress-percent={percent}
      data-progress-ratio={progress.ratio.toFixed(3)}
      data-partial={progress.partial ? "true" : "false"}
      data-built={progress.built ? "true" : "false"}
      data-earliest-missing={progress.earliestMissingStage ?? "none"}
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
    </div>
  );
}
