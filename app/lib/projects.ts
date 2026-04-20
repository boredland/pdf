import { DEFAULT_SETTINGS, getDb, type Project } from "~/lib/storage/db";
import { removeFile, writeFile } from "~/lib/storage/opfs";
import {
  convertImageToPdf,
  isImageFile,
  isImageFileName,
} from "~/lib/images/image-to-pdf";

export async function createProjectFromBytes(
  name: string,
  bytes: ArrayBuffer,
  mimeType?: string,
): Promise<Project> {
  const db = getDb();
  const id = `proj-${crypto.randomUUID().slice(0, 8)}`;
  const sourcePdfPath = `${id}/source.pdf`;

  // Convert image files to PDF with EXIF rotation
  let pdfBytes = bytes;
  if (
    mimeType &&
    isImageFile(mimeType) &&
    isImageFileName(name)
  ) {
    pdfBytes = await convertImageToPdf(
      new Uint8Array(bytes),
      mimeType,
      name,
    );
  } else if (isImageFileName(name)) {
    // Guess MIME type from filename if not provided
    const ext = name.toLowerCase().split(".").pop();
    const guessedMimeType =
      ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
    if (isImageFile(guessedMimeType)) {
      pdfBytes = await convertImageToPdf(
        new Uint8Array(bytes),
        guessedMimeType,
        name,
      );
    }
  }

  const pdfBytesU8 = new Uint8Array(pdfBytes);
  await writeFile(sourcePdfPath, pdfBytesU8);
  const project: Project = {
    id,
    name,
    createdAt: Date.now(),
    sourcePdfPath,
    sourceSizeBytes: pdfBytesU8.byteLength,
    pageCount: 0,
    settings: structuredClone(DEFAULT_SETTINGS),
  };
  await db.projects.put(project);
  return project;
}

export async function getProject(id: string): Promise<Project | undefined> {
  return getDb().projects.get(id);
}

export async function listProjects(): Promise<Project[]> {
  return getDb().projects.orderBy("createdAt").reverse().toArray();
}

/**
 * Remove a single page from a project. Wipes every artifact the page
 * owned (render, preprocess, detect, ocr, mrc and their overlays), drops
 * the page row, decrements project.pageCount, and invalidates
 * project.build (the page-count changed, so the prior build is stale).
 *
 * Page indices are NOT renumbered on disk — the UI displays a
 * display-position derived from the sorted list, so a hole in the raw
 * index range is invisible to the user.
 */
export async function removePage(
  projectId: string,
  pageIndex: number,
): Promise<void> {
  const db = getDb();
  const pageKey = `${projectId}:${pageIndex}`;
  const page = await db.pages.get(pageKey);
  const project = await db.projects.get(projectId);
  if (!project || !page) return;

  // Page-owned artifact files.
  const paths = new Set<string>();
  for (const status of Object.values(page.status ?? {})) {
    if (!status) continue;
    if (status.artifactPath) paths.add(status.artifactPath);
    if (status.overlayPath) paths.add(status.overlayPath);
  }
  await Promise.all(
    [...paths].map((p) => removeFile(p).catch(() => undefined)),
  );

  await db.pages.delete(pageKey);

  // project.build is project-scoped and conceptually covers all pages,
  // so dropping a page invalidates it. Use put so Dexie actually clears
  // the optional field.
  const { build, ...rest } = project;
  if (build) await removeFile(build.artifactPath).catch(() => undefined);
  await db.projects.put({
    ...rest,
    pageCount: Math.max(0, project.pageCount - 1),
  });
}
