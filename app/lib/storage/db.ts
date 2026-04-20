import Dexie, { type EntityTable } from "dexie";

export type Stage = "render" | "preprocess" | "detect" | "ocr" | "mrc" | "build";

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  sourcePdfPath: string;
  pageCount: number;
  settings: ProjectSettings;
}

export interface ProjectSettings {
  render: { dpi: number };
  preprocess: { deskew: boolean; binarizer: "sauvola" | "otsu"; denoiseRadius: number };
  detect: { enabled: boolean };
  ocr: { providerId: string; language: string };
  mrc: { preset: "lossless" | "archival" | "compact" };
}

export interface PageStageStatus {
  hash: string;
  completedAt: number;
  artifactPath: string;
  sizeBytes?: number;
  /** secondary image artifact path (e.g. detect-overlay.png) */
  overlayPath?: string;
  /** preprocess: measured skew angle before deskew rotation (degrees) */
  skewAngleDegrees?: number;
}

export interface Page {
  id: string;
  projectId: string;
  index: number;
  status: Partial<Record<Stage, PageStageStatus>>;
  thumbnailDataUrl?: string;
  /** per-stage thumbnails (data URLs), populated as each stage completes */
  thumbnails?: Partial<Record<Stage, string>>;
}

export interface Job {
  id: string;
  projectId: string;
  createdAt: number;
  status: "queued" | "running" | "paused" | "aborted" | "done" | "failed";
  stages: Stage[];
  pagesTotal: number;
  pagesDone: number;
  error?: string;
}

export interface Setting {
  key: string;
  value: unknown;
}

export interface ApiKey {
  providerId: string;
  ciphertext: ArrayBuffer;
  iv: ArrayBuffer;
  salt: ArrayBuffer;
  createdAt: number;
}

export type AppDB = Dexie & {
  projects: EntityTable<Project, "id">;
  pages: EntityTable<Page, "id">;
  jobs: EntityTable<Job, "id">;
  settings: EntityTable<Setting, "key">;
  apiKeys: EntityTable<ApiKey, "providerId">;
};

let _db: AppDB | null = null;

export function getDb(): AppDB {
  if (_db) return _db;
  const db = new Dexie("pdf-ocr") as AppDB;
  db.version(1).stores({
    projects: "id, name, createdAt",
    pages: "id, projectId, [projectId+index]",
    jobs: "id, projectId, status, createdAt",
    settings: "key",
    apiKeys: "providerId",
  });
  _db = db;
  return db;
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  render: { dpi: 300 },
  preprocess: { deskew: true, binarizer: "sauvola", denoiseRadius: 1 },
  detect: { enabled: true },
  ocr: { providerId: "tesseract", language: "eng" },
  mrc: { preset: "archival" },
};
