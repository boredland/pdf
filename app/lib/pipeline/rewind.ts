import { DOWNSTREAM_STAGES } from "~/lib/artifacts";
import { getDb, type Stage, type Page } from "~/lib/storage/db";
import { removeFile } from "~/lib/storage/opfs";

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
}
