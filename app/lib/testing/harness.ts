import { getDb } from "~/lib/storage/db";
import { writeFile, readBlob, removeFile, estimateUsage } from "~/lib/storage/opfs";
import { wrapSecret, unwrapSecret } from "~/lib/storage/keys";
import { getCacheStatus, purgeCaches } from "~/lib/cache/register-sw";
import { settingsHash, artifactPath } from "~/lib/artifacts";
import { DEFAULT_SETTINGS } from "~/lib/storage/db";
import { createProjectFromBytes, listProjects, getProject } from "~/lib/projects";
import {
  ensurePageRows,
  runRenderPipeline,
  dropRenderArtifacts,
} from "~/lib/pipeline/render-pipeline";
import { EXAMPLE_PDF_URL, loadExamplePdf } from "~/lib/examples";

declare global {
  interface Window {
    __pdfApp?: {
      db: ReturnType<typeof getDb>;
      opfs: {
        writeFile: typeof writeFile;
        readBlob: typeof readBlob;
        removeFile: typeof removeFile;
        estimateUsage: typeof estimateUsage;
      };
      keys: { wrapSecret: typeof wrapSecret; unwrapSecret: typeof unwrapSecret };
      cache: { getCacheStatus: typeof getCacheStatus; purgeCaches: typeof purgeCaches };
      artifacts: {
        settingsHash: typeof settingsHash;
        artifactPath: typeof artifactPath;
        DEFAULT_SETTINGS: typeof DEFAULT_SETTINGS;
      };
      projects: {
        createProjectFromBytes: typeof createProjectFromBytes;
        listProjects: typeof listProjects;
        getProject: typeof getProject;
      };
      render: {
        ensurePageRows: typeof ensurePageRows;
        runRenderPipeline: typeof runRenderPipeline;
        dropRenderArtifacts: typeof dropRenderArtifacts;
      };
      example: {
        url: string;
        load: typeof loadExamplePdf;
      };
    };
    __pdfRenderCallCount?: number;
  }
}

export function installTestHarness(): void {
  if (typeof window === "undefined") return;
  // The harness is tiny and only exposes things that are already loaded.
  // It's safe to ship in production — it never mutates state on its own.
  window.__pdfApp = {
    db: getDb(),
    opfs: { writeFile, readBlob, removeFile, estimateUsage },
    keys: { wrapSecret, unwrapSecret },
    cache: { getCacheStatus, purgeCaches },
    artifacts: { settingsHash, artifactPath, DEFAULT_SETTINGS },
    projects: { createProjectFromBytes, listProjects, getProject },
    render: { ensurePageRows, runRenderPipeline, dropRenderArtifacts },
    example: { url: EXAMPLE_PDF_URL, load: loadExamplePdf },
  };
}
