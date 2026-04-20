import { DOWNSTREAM_STAGES } from "~/lib/artifacts";
import { getDb, type Stage, type Page } from "~/lib/storage/db";
import { removeFile } from "~/lib/storage/opfs";

/**
 * Set a per-page rotation override and invalidate the stages that depend
 * on the preprocess output for *that page specifically*. Also drops
 * project.build because that's a per-project artifact whose hash now no
 * longer matches one of its input pages.
 */
export async function setPageRotationOverride(
  projectId: string,
  pageIndex: number,
  angle: 0 | 90 | 180 | 270 | null,
): Promise<void> {
  const db = getDb();
  const pageKey = `${projectId}:${pageIndex}`;
  const page = await db.pages.get(pageKey);
  if (!page) return;
  const cleared: Page["status"] = { ...(page.status ?? {}) };
  for (const s of DOWNSTREAM_STAGES.preprocess) {
    const status = cleared[s];
    if (status) await removeFile(status.artifactPath).catch(() => undefined);
    delete cleared[s];
  }
  const update: Partial<Page> & { rotationOverride?: 0 | 90 | 180 | 270 | null } = {
    status: cleared,
  };
  if (angle === null) {
    // Rewrite the row so Dexie actually clears the key.
    const { rotationOverride: _dropped, ...rest } = page;
    await db.pages.put({ ...rest, status: cleared });
  } else {
    update.rotationOverride = angle;
    await db.pages.update(pageKey, update);
  }

  // project.build always depends on every page; drop it.
  const project = await db.projects.get(projectId);
  if (project?.build) {
    await removeFile(project.build.artifactPath).catch(() => undefined);
    const { build: _d, ...rest } = project;
    await db.projects.put(rest);
  }
}

export async function rewindToStage(projectId: string, stage: Stage): Promise<void> {
  const db = getDb();
  const downstream = DOWNSTREAM_STAGES[stage];
  const pages = await db.pages.where({ projectId }).toArray();
  for (const page of pages) {
    const cleared: Page["status"] = { ...(page.status ?? {}) };
    for (const s of downstream) {
      const status = cleared[s];
      if (status) await removeFile(status.artifactPath).catch(() => undefined);
      delete cleared[s];
    }
    const update: Partial<Page> = { status: cleared };
    if (stage === "render") update.thumbnailDataUrl = undefined;
    await db.pages.update(page.id, update);
  }

  // The build artifact is project-scoped, not page-scoped — iterate at the
  // project level when build is downstream of the rewind target. Dexie's
  // `update({ build: undefined })` is a no-op (undefined means "don't
  // touch"), so re-put the project without the build field to drop it.
  if (downstream.includes("build")) {
    const project = await db.projects.get(projectId);
    if (project?.build) {
      await removeFile(project.build.artifactPath).catch(() => undefined);
      const { build: _dropped, ...rest } = project;
      await db.projects.put(rest);
    }
  }
}
