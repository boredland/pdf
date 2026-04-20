import type { ProjectSettings, Stage } from "./storage/db";

const STAGE_DEPENDENCIES: Record<Stage, readonly (keyof ProjectSettings)[]> = {
  render: ["render"],
  preprocess: ["render", "preprocess"],
  detect: ["render", "preprocess", "detect"],
  ocr: ["render", "preprocess", "detect", "ocr"],
  mrc: ["render", "preprocess", "mrc"],
  build: ["render", "preprocess", "detect", "ocr", "mrc"],
};

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sortedJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sortedJsonStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJsonStringify(v)}`).join(",")}}`;
}

export async function settingsHash(settings: ProjectSettings, stage: Stage): Promise<string> {
  const relevant: Partial<ProjectSettings> = {};
  for (const key of STAGE_DEPENDENCIES[stage]) {
    relevant[key] = settings[key] as never;
  }
  const canonical = sortedJsonStringify({ stage, settings: relevant });
  const hex = await sha256Hex(canonical);
  return hex.slice(0, 16);
}

export function artifactPath(params: {
  projectId: string;
  pageIndex: number;
  stage: Stage;
  hash: string;
  extension: string;
}): string {
  const { projectId, pageIndex, stage, hash, extension } = params;
  return `${projectId}/pages/${pageIndex}/${stage}.${hash}.${extension}`;
}

export function stageArtifactGlob(projectId: string, pageIndex: number, stage: Stage): string {
  return `${projectId}/pages/${pageIndex}/${stage}.`;
}

export const DOWNSTREAM_STAGES: Record<Stage, readonly Stage[]> = {
  render: ["render", "preprocess", "detect", "ocr", "mrc", "build"],
  preprocess: ["preprocess", "detect", "ocr", "mrc", "build"],
  detect: ["detect", "ocr", "build"],
  ocr: ["ocr", "build"],
  mrc: ["mrc", "build"],
  build: ["build"],
};
