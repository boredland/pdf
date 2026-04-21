import { DOWNSTREAM_STAGES } from "~/lib/artifacts";
import { getDb, type Page, type Project, type Stage } from "~/lib/storage/db";
import { readBlob } from "~/lib/storage/opfs";

export interface ProjectProgress {
  pageCount: number;
  /** Which stages are "done" across all pages (plus build as one project-level step). */
  stagesDone: number;
  /** Total stages expected: pageCount × per-page stages + 1 (build). */
  stagesTotal: number;
  /** 0..1 overall progress. */
  ratio: number;
  /** pages where not every pre-build stage is complete. */
  incompletePageIndices: number[];
  /** earliest stage where at least one page is missing an artifact. */
  earliestMissingStage: Stage | null;
  /** true when the project has some artifacts but not all. */
  partial: boolean;
  /** true when the final build artifact is present. */
  built: boolean;
}

// MRC is no longer in the critical path — the builder overlays text onto
// the original source PDF. Progress tracks only the stages required for
// build: render → preprocess → detect → ocr → (build).
const PAGE_STAGES: Exclude<Stage, "build">[] = [
  "render",
  "preprocess",
  "detect",
  "ocr",
];

export function computeProgress(project: Project, pages: Page[]): ProjectProgress {
  const stagesPerPage = PAGE_STAGES.length;
  const stagesTotal = project.pageCount * stagesPerPage + 1;
  let stagesDone = 0;
  const incompletePageIndices: number[] = [];
  let earliestMissingStage: Stage | null = null;

  for (let i = 0; i < project.pageCount; i++) {
    const page = pages.find((p) => p.index === i);
    let pageComplete = true;
    for (const stage of PAGE_STAGES) {
      if (page?.status[stage]) {
        stagesDone++;
      } else {
        pageComplete = false;
        if (!earliestMissingStage || rankStage(stage) < rankStage(earliestMissingStage)) {
          earliestMissingStage = stage;
        }
      }
    }
    if (!pageComplete) incompletePageIndices.push(i);
  }

  const built = !!project.build;
  if (built) stagesDone++;
  else if (!earliestMissingStage) earliestMissingStage = "build";

  return {
    pageCount: project.pageCount,
    stagesDone,
    stagesTotal,
    ratio: stagesTotal === 0 ? 0 : stagesDone / stagesTotal,
    incompletePageIndices,
    earliestMissingStage,
    partial: stagesDone > 0 && stagesDone < stagesTotal,
    built,
  };
}

function rankStage(stage: Stage): number {
  const order: Record<Stage, number> = {
    render: 0,
    preprocess: 1,
    detect: 2,
    ocr: 3,
    build: 5,
  };
  return order[stage];
}

export interface SettingsInvalidation {
  /** stages that would be invalidated (including downstream). */
  stages: Stage[];
  /** total artifact count that would be discarded. */
  artifactCount: number;
  /** total bytes on disk that would be discarded. */
  byteCount: number;
}

/**
 * Predict which artifacts a settings change would invalidate. Used by the
 * settings UI to show a confirmation dialog before clobbering hours of work.
 */
export async function predictInvalidation(
  projectId: string,
  changedStages: Exclude<Stage, "build">[],
): Promise<SettingsInvalidation> {
  const db = getDb();
  const project = await db.projects.get(projectId);
  const pages = await db.pages.where({ projectId }).toArray();
  if (!project) return { stages: [], artifactCount: 0, byteCount: 0 };

  const seen = new Set<Stage>();
  for (const s of changedStages) {
    for (const downstream of DOWNSTREAM_STAGES[s]) {
      seen.add(downstream);
    }
  }
  const stages = [...seen] as Stage[];

  let artifactCount = 0;
  let byteCount = 0;
  for (const page of pages) {
    for (const stage of stages) {
      if (stage === "build") continue;
      const status = page.status[stage];
      if (!status) continue;
      artifactCount++;
      byteCount += status.sizeBytes ?? 0;
    }
  }
  if (stages.includes("build") && project.build) {
    artifactCount++;
    byteCount += project.build.sizeBytes ?? 0;
  }
  return { stages, artifactCount, byteCount };
}

/**
 * Estimated remaining-download bytes from OPFS if the user bailed now; used in
 * tests to confirm "resume" doesn't re-fetch anything.
 */
export async function sumArtifactBytes(projectId: string): Promise<number> {
  const pages = await getDb().pages.where({ projectId }).toArray();
  let bytes = 0;
  for (const page of pages) {
    for (const status of Object.values(page.status)) {
      if (!status) continue;
      if (status.sizeBytes) bytes += status.sizeBytes;
      if (status.overlayPath) {
        const blob = await readBlob(status.overlayPath);
        if (blob) bytes += blob.size;
      }
    }
  }
  const project = await getDb().projects.get(projectId);
  if (project?.build) bytes += project.build.sizeBytes ?? 0;
  return bytes;
}
