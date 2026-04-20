import type { Project, Stage } from "~/lib/storage/db";
import { runRenderPipeline } from "~/lib/pipeline/render-pipeline";
import { runPreprocessPipeline } from "~/lib/pipeline/preprocess-pipeline";
import { runDetectPipeline } from "~/lib/pipeline/detect-pipeline";
import { runOcrPipeline } from "~/lib/pipeline/ocr-pipeline";
import { runMrcPipeline } from "~/lib/pipeline/mrc-pipeline";

export interface RunStageOptions {
  signal?: AbortSignal;
  pageIndices?: number[];
}

type Runner = (project: Project, options: RunStageOptions) => Promise<void>;

const RUNNERS: Record<Exclude<Stage, "build">, Runner> = {
  render: runRenderPipeline,
  preprocess: runPreprocessPipeline,
  detect: runDetectPipeline,
  ocr: runOcrPipeline,
  mrc: runMrcPipeline,
};

export const PIPELINE_ORDER: Array<Exclude<Stage, "build">> = [
  "render",
  "preprocess",
  "detect",
  "ocr",
  "mrc",
];

export async function runStage(
  project: Project,
  stage: Exclude<Stage, "build">,
  options: RunStageOptions = {},
): Promise<void> {
  return RUNNERS[stage](project, options);
}

export async function runFromStage(
  project: Project,
  fromStage: Exclude<Stage, "build"> | "all",
  options: RunStageOptions = {},
): Promise<void> {
  const startIdx =
    fromStage === "all" ? 0 : PIPELINE_ORDER.indexOf(fromStage);
  for (let i = startIdx; i < PIPELINE_ORDER.length; i++) {
    if (options.signal?.aborted) return;
    const stage = PIPELINE_ORDER[i]!;
    await RUNNERS[stage](project, options);
  }
}
