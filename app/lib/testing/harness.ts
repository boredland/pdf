import { getDb } from "~/lib/storage/db";
import { writeFile, readBlob, removeFile, estimateUsage } from "~/lib/storage/opfs";
import { wrapSecret, unwrapSecret } from "~/lib/storage/keys";
import { getCacheStatus, purgeCaches } from "~/lib/cache/register-sw";
import { settingsHash, artifactPath } from "~/lib/artifacts";
import { DEFAULT_SETTINGS } from "~/lib/storage/db";
import {
  createProjectFromBytes,
  getProject,
  listProjects,
  removePage,
} from "~/lib/projects";
import {
  ensurePageRows,
  runRenderPipeline,
  dropRenderArtifacts,
} from "~/lib/pipeline/render-pipeline";
import { runPreprocessPipeline } from "~/lib/pipeline/preprocess-pipeline";
import { measureSkew } from "~/lib/workers/preprocess-client";
import { runDetectPipeline, readDetectRegions } from "~/lib/pipeline/detect-pipeline";
import { runOcrPipeline, readOcrResult } from "~/lib/pipeline/ocr-pipeline";
import { runBuildPipeline, readBuildOutput } from "~/lib/pipeline/build-pipeline";
import { getPageCount as renderGetPageCount } from "~/lib/workers/render-client";
import { runStage, runFromStage, PIPELINE_ORDER } from "~/lib/pipeline/run-stage";
import {
  computeProgress,
  predictInvalidation,
  sumArtifactBytes,
} from "~/lib/project-progress";
import { getProvider, listProviders, registerProvider } from "~/lib/providers/registry";
import { mockProvider } from "~/lib/providers/mock";
import {
  downloadLanguage,
  isLanguageCached,
  LANGUAGES,
  traineddataUrl,
} from "~/lib/languages";
import {
  clearSessionPassphrase,
  forgetApiKey,
  hasApiKey,
  hasSessionPassphrase,
  setSessionPassphrase,
  storeApiKey,
} from "~/lib/api-keys";
import { rewindToStage, setPageRotationOverride } from "~/lib/pipeline/rewind";
import {
  exportProjectAlto,
  exportProjectHocr,
} from "~/lib/export/export-hocr";
import { EXAMPLE_PDFS, loadExamplePdf } from "~/lib/examples";
import {
  getExifOrientation,
  getRotationTransform,
} from "~/lib/images/exif-orientation";

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
        removePage: typeof removePage;
      };
      render: {
        ensurePageRows: typeof ensurePageRows;
        runRenderPipeline: typeof runRenderPipeline;
        dropRenderArtifacts: typeof dropRenderArtifacts;
        getPageCount: typeof renderGetPageCount;
      };
      pdfInspect: {
        /** Extract per-page text from a PDF blob via mupdf (test-only). */
        extractText: (bytes: ArrayBuffer) => Promise<string[]>;
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
      build: {
        runBuildPipeline: typeof runBuildPipeline;
        readBuildOutput: typeof readBuildOutput;
      };
      exportHocr: typeof exportProjectHocr;
      exportAlto: typeof exportProjectAlto;
      progress: {
        compute: typeof computeProgress;
        predict: typeof predictInvalidation;
        sumBytes: typeof sumArtifactBytes;
      };
      pipeline: {
        runStage: typeof runStage;
        runFromStage: typeof runFromStage;
        order: typeof PIPELINE_ORDER;
      };
      languages: {
        list: typeof LANGUAGES;
        isCached: typeof isLanguageCached;
        download: typeof downloadLanguage;
        url: typeof traineddataUrl;
      };
      apiKeys: {
        has: typeof hasApiKey;
        store: typeof storeApiKey;
        forget: typeof forgetApiKey;
        setPassphrase: typeof setSessionPassphrase;
        clearPassphrase: typeof clearSessionPassphrase;
        hasPassphrase: typeof hasSessionPassphrase;
      };
      rewind: {
        toStage: typeof rewindToStage;
        setRotationOverride: typeof setPageRotationOverride;
      };
      example: {
        url: string;
        load: () => Promise<ArrayBuffer>;
        loadById: typeof loadExamplePdf;
      };
      testing: {
        /**
         * Mutate DEFAULT_SETTINGS.ocr.providerId. Affects every subsequent
         * createProjectFromBytes call in this browser context. Used by e2e
         * specs to swap in the "mock" provider and bypass real OCR.
         */
        setDefaultOcrProvider: (id: string) => void;
        /**
         * Toggle OSD orientation detection in DEFAULT_SETTINGS. Specs that
         * don't care about rotation flip this off to skip the ~10 MB OSD
         * worker boot on each test context.
         */
        setDefaultOrientationDetect: (enabled: boolean) => void;
        exif: {
          getOrientation: typeof getExifOrientation;
          getRotationTransform: typeof getRotationTransform;
        };
      };
    };
    __pdfRenderCallCount?: number;
    __pdfPreprocessCallCount?: number;
    __pdfDetectCallCount?: number;
    __pdfBuildCallCount?: number;
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
    projects: { createProjectFromBytes, listProjects, getProject, removePage },
    render: {
      ensurePageRows,
      runRenderPipeline,
      dropRenderArtifacts,
      getPageCount: renderGetPageCount,
    },
    pdfInspect: {
      extractText: async (bytes: ArrayBuffer) => {
        const mupdf = await import("mupdf");
        const doc = mupdf.Document.openDocument(
          new Uint8Array(bytes),
          "application/pdf",
        );
        try {
          const out: string[] = [];
          for (let i = 0; i < doc.countPages(); i++) {
            const p = doc.loadPage(i) as import("mupdf").PDFPage;
            try {
              const stext = p.toStructuredText("preserve-whitespace");
              out.push(stext.asText());
            } finally {
              p.destroy();
            }
          }
          return out;
        } finally {
          doc.destroy();
        }
      },
    },
    preprocess: { runPreprocessPipeline, measureSkew },
    detect: { runDetectPipeline, readDetectRegions },
    ocr: { runOcrPipeline, readOcrResult, listProviders },
    build: { runBuildPipeline, readBuildOutput },
    exportHocr: exportProjectHocr,
    exportAlto: exportProjectAlto,
    progress: {
      compute: computeProgress,
      predict: predictInvalidation,
      sumBytes: sumArtifactBytes,
    },
    pipeline: { runStage, runFromStage, order: PIPELINE_ORDER },
    languages: {
      list: LANGUAGES,
      isCached: isLanguageCached,
      download: downloadLanguage,
      url: traineddataUrl,
    },
    apiKeys: {
      has: hasApiKey,
      store: storeApiKey,
      forget: forgetApiKey,
      setPassphrase: setSessionPassphrase,
      clearPassphrase: clearSessionPassphrase,
      hasPassphrase: hasSessionPassphrase,
    },
    rewind: {
      toStage: rewindToStage,
      setRotationOverride: setPageRotationOverride,
    },
    example: {
      url: EXAMPLE_PDFS.synthetic.url,
      // Back-compat: tests depending on exact OCR text pass through synthetic.
      load: () => loadExamplePdf("synthetic"),
      loadById: loadExamplePdf,
    },
    testing: {
      setDefaultOcrProvider: (id: string) => {
        // The mock provider isn't registered in the default registry (it
        // would otherwise leak into prod's provider dropdown). Register it
        // here lazily when a spec asks for it.
        if (id === "mock") {
          try {
            getProvider("mock");
          } catch {
            registerProvider(mockProvider);
          }
        }
        DEFAULT_SETTINGS.ocr.providerId = id;
      },
      setDefaultOrientationDetect: (enabled: boolean) => {
        DEFAULT_SETTINGS.preprocess.orientationDetect = enabled;
      },
      exif: {
        getOrientation: getExifOrientation,
        getRotationTransform,
      },
    },
  };
}
