import { DEFAULT_SETTINGS, getDb, type Project } from "~/lib/storage/db";
import { writeFile } from "~/lib/storage/opfs";
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

  await writeFile(sourcePdfPath, new Uint8Array(pdfBytes));
  const project: Project = {
    id,
    name,
    createdAt: Date.now(),
    sourcePdfPath,
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
