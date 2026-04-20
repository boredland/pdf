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
import { runPreprocessPipeline } from "~/lib/pipeline/preprocess-pipeline";
import { measureSkew } from "~/lib/workers/preprocess-client";
import { runDetectPipeline, readDetectRegions } from "~/lib/pipeline/detect-pipeline";
import { runOcrPipeline, readOcrResult } from "~/lib/pipeline/ocr-pipeline";
import { listProviders } from "~/lib/providers/registry";
import {
  clearSessionPassphrase,
  forgetApiKey,
  hasApiKey,
  hasSessionPassphrase,
  setSessionPassphrase,
  storeApiKey,
} from "~/lib/api-keys";
import { rewindToStage } from "~/lib/pipeline/rewind";
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
      preprocess: {
        runPreprocessPipeline: typeof runPreprocessPipeline;
        measureSkew: typeof measureSkew;
      };
      detect: {
        runDetectPipeline: typeof runDetectPipeline;
        readDetectRegions: typeof readDetectRegions;
      };
      ocr: {
        runOcrPipeline: typeof runOcrPipeline;
        readOcrResult: typeof readOcrResult;
        listProviders: typeof listProviders;
      };
      apiKeys: {
        has: typeof hasApiKey;
        store: typeof storeApiKey;
        forget: typeof forgetApiKey;
        setPassphrase: typeof setSessionPassphrase;
        clearPassphrase: typeof clearSessionPassphrase;
        hasPassphrase: typeof hasSessionPassphrase;
      };
      rewind: { toStage: typeof rewindToStage };
      example: {
        url: string;
        load: typeof loadExamplePdf;
      };
    };
    __pdfRenderCallCount?: number;
    __pdfPreprocessCallCount?: number;
    __pdfDetectCallCount?: number;
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
    preprocess: { runPreprocessPipeline, measureSkew },
    detect: { runDetectPipeline, readDetectRegions },
    ocr: { runOcrPipeline, readOcrResult, listProviders },
    apiKeys: {
      has: hasApiKey,
      store: storeApiKey,
      forget: forgetApiKey,
      setPassphrase: setSessionPassphrase,
      clearPassphrase: clearSessionPassphrase,
      hasPassphrase: hasSessionPassphrase,
    },
    rewind: { toStage: rewindToStage },
    example: { url: EXAMPLE_PDF_URL, load: loadExamplePdf },
  };
}
