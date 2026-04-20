import { getDb, type Project, type Stage } from "~/lib/storage/db";
import { runRenderPipeline } from "~/lib/pipeline/render-pipeline";
import { runPreprocessPipeline } from "~/lib/pipeline/preprocess-pipeline";
import { runDetectPipeline } from "~/lib/pipeline/detect-pipeline";
import { runOcrPipeline } from "~/lib/pipeline/ocr-pipeline";
import { runMrcPipeline } from "~/lib/pipeline/mrc-pipeline";
import { runBuildPipeline } from "~/lib/pipeline/build-pipeline";

export interface RunStageOptions {
  signal?: AbortSignal;
  pageIndices?: number[];
}

type Runner = (project: Project, options: RunStageOptions) => Promise<void>;

const RUNNERS: Record<Stage, Runner> = {
  render: runRenderPipeline,
  preprocess: runPreprocessPipeline,
  detect: runDetectPipeline,
  ocr: runOcrPipeline,
  mrc: runMrcPipeline,
  // Build ignores pageIndices — it's a project-wide stage by nature.
  build: (project, options) => runBuildPipeline(project, { signal: options.signal }),
};

export const PIPELINE_ORDER: Stage[] = [
  "render",
  "preprocess",
  "detect",
  "ocr",
  "mrc",
  "build",
];

export async function runStage(
  project: Project,
  stage: Stage,
  options: RunStageOptions = {},
): Promise<void> {
  return RUNNERS[stage](project, options);
}

/**
 * Run the pipeline from `fromStage` onwards. Per-page stages are driven as a
 * per-page DAG: each page advances through render → preprocess → detect →
 * ocr → mrc at its own pace, so page 0 can be in OCR while page 2 is still
 * rendering. Build is the only project-wide join and runs after every page
 * completes its page-stage chain.
 */
export async function runFromStage(
  project: Project,
  fromStage: Stage | "all",
  options: RunStageOptions = {},
): Promise<void> {
  const startIdx =
    fromStage === "all" ? 0 : PIPELINE_ORDER.indexOf(fromStage);
  const remainingStages = PIPELINE_ORDER.slice(startIdx);
  const pageStages = remainingStages.filter((s) => s !== "build");
  const runBuildAfter =
    remainingStages.includes("build") && !options.pageIndices;

  const pageIndices =
    options.pageIndices ??
    [...Array.from({ length: project.pageCount }, (_, i) => i)];

  // Fan out per-page DAGs. Promise.all gives every page to the JS event
  // loop at once; individual workers serialise internally (OpenCV, mupdf)
  // but the cross-worker overlap (preprocess on page A + OCR on page B)
  // lets us use more than one worker pool at a time.
  await Promise.all(
    pageIndices.map(async (pageIndex) => {
      for (const stage of pageStages) {
        if (options.signal?.aborted) return;
        // Refetch the project row between stages so settings changes
        // (e.g. provider swap mid-run) or side-effects (project.build
        // drops) propagate.
        const fresh = await getDb().projects.get(project.id);
        if (!fresh) return;
        await RUNNERS[stage](fresh, {
          signal: options.signal,
          pageIndices: [pageIndex],
        });
      }
    }),
  );

  if (runBuildAfter && !options.signal?.aborted) {
    const fresh = await getDb().projects.get(project.id);
    if (!fresh) return;
    await RUNNERS.build(fresh, { signal: options.signal });
  }
}
