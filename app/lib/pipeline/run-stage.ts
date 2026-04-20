import type { Project, Stage } from "~/lib/storage/db";
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

export async function runFromStage(
  project: Project,
  fromStage: Stage | "all",
  options: RunStageOptions = {},
): Promise<void> {
  const startIdx =
    fromStage === "all" ? 0 : PIPELINE_ORDER.indexOf(fromStage);
  for (let i = startIdx; i < PIPELINE_ORDER.length; i++) {
    if (options.signal?.aborted) return;
    const stage = PIPELINE_ORDER[i]!;
    // Build requires the whole project; page-scoped runs skip it.
    if (stage === "build" && options.pageIndices) continue;
    await RUNNERS[stage](project, options);
  }
}
