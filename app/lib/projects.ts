import { DEFAULT_SETTINGS, getDb, type Project } from "~/lib/storage/db";
import { writeFile } from "~/lib/storage/opfs";

export async function createProjectFromBytes(
  name: string,
  bytes: ArrayBuffer,
): Promise<Project> {
  const db = getDb();
  const id = `proj-${crypto.randomUUID().slice(0, 8)}`;
  const sourcePdfPath = `${id}/source.pdf`;
  await writeFile(sourcePdfPath, new Uint8Array(bytes));
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
