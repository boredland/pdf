/**
 * Tesseract Orientation and Script Detection (OSD).
 *
 * Classifies a page as 0/90/180/270° rotated. We use this to catch pages
 * that were fed in upside-down (common with scans lacking EXIF metadata).
 * OSD requires its own traineddata (`osd.traineddata`, ~10 MB), which we
 * ship from `public/tesseract/` and cache via the service worker.
 */

import { createWorker } from "tesseract.js";
import { logger } from "~/lib/logger";

const log = logger.child({ module: "osd" });

const BASE = import.meta.env.BASE_URL;
const OSD_LANG_PATH = `${BASE}tesseract/`;
/** Hard ceiling: if OSD doesn't return in this window, skip it. */
const OSD_TIMEOUT_MS = 20_000;
/** Confidence below this yields "no rotation". */
const MIN_CONFIDENCE = 2;

export type OsdAngle = 0 | 90 | 180 | 270;
/** Angles we act on. All cardinal rotations supported. */
export type AppliedRotation = OsdAngle;

export interface OsdResult {
  /** Raw cardinal angle returned by OSD (0/90/180/270). */
  rawAngle: OsdAngle;
  /** Angle we'll actually apply in preprocess. */
  angle: AppliedRotation;
  confidence: number;
  /** Detected script label (e.g. "Latin", "Cyrillic", "Han"). */
  script: string | null;
  scriptConfidence: number;
  /** `true` iff the OSD call succeeded within the timeout. */
  ok: boolean;
}

let osdWorkerPromise: Promise<Awaited<ReturnType<typeof createWorker>>> | null =
  null;

async function getOsdWorker() {
  if (!osdWorkerPromise) {
    // OEM 0 = TESSERACT_ONLY (legacy heuristic). OSD is a legacy-only
    // feature; LSTM-only cores throw "Legacy model not loaded".
    osdWorkerPromise = createWorker("osd", 0, {
      corePath: `${BASE}tesseract/`,
      workerPath: `${BASE}tesseract/worker.min.js`,
      langPath: OSD_LANG_PATH,
      gzip: false,
    }).catch((err) => {
      osdWorkerPromise = null;
      throw err;
    });
  }
  return osdWorkerPromise;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Detect the rotation needed to bring `pngBytes` upright (0/90/180/270°).
 * Never throws — failures return `{ ok: false, angle: 0, confidence: 0 }`
 * so callers can treat "no OSD" and "upright" identically.
 */
export async function detectOrientation(
  pngBytes: ArrayBuffer | Uint8Array,
): Promise<OsdResult> {
  const bytes =
    pngBytes instanceof Uint8Array ? pngBytes : new Uint8Array(pngBytes);
  const blob = new Blob([bytes.slice().buffer], { type: "image/png" });
  try {
    const worker = await withTimeout(
      getOsdWorker(),
      OSD_TIMEOUT_MS,
      "OSD worker init",
    );
    const result = (await withTimeout(
      // Tesseract's .detect runs OSD on the already-initialised worker.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (worker as any).detect(blob),
      OSD_TIMEOUT_MS,
      "OSD detect",
    )) as {
      data?: {
        orientation_degrees?: number;
        orientation_confidence?: number;
        script?: string;
        script_confidence?: number;
        // Older tesseract.js versions used {angle, confidence}
        angle?: number;
        confidence?: number;
      };
    };

    const rawAngleNumeric =
      result.data?.orientation_degrees ?? result.data?.angle ?? 0;
    const confidence =
      result.data?.orientation_confidence ?? result.data?.confidence ?? 0;
    const script = result.data?.script ?? null;
    const scriptConfidence = result.data?.script_confidence ?? 0;

    const rawAngle = normaliseAngle(rawAngleNumeric);
    if (confidence < MIN_CONFIDENCE) {
      return {
        ok: true,
        rawAngle,
        angle: 0,
        confidence,
        script,
        scriptConfidence,
      };
    }
    return {
      ok: true,
      rawAngle,
      angle: rawAngle,
      confidence,
      script,
      scriptConfidence,
    };
  } catch (err) {
    log.warn({ evt: "osd_failed", err: (err as Error).message });
    return {
      ok: false,
      rawAngle: 0,
      angle: 0,
      confidence: 0,
      script: null,
      scriptConfidence: 0,
    };
  }
}

function normaliseAngle(angle: number): OsdAngle {
  // OSD returns 0/90/180/270 (the rotation *of* the page vs upright).
  // Tesseract's detect returns the rotation you need to apply to make
  // it upright. Round + wrap defensively.
  const wrapped = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
  if (wrapped === 90 || wrapped === 180 || wrapped === 270) return wrapped;
  return 0;
}

/** Tear down the shared worker — used by tests. */
export async function disposeOsd(): Promise<void> {
  if (!osdWorkerPromise) return;
  const worker = await osdWorkerPromise.catch(() => null);
  osdWorkerPromise = null;
  if (worker) await worker.terminate();
}
