/// <reference lib="webworker" />
import * as Comlink from "comlink";
import opencvUrl from "@techstark/opencv-js/dist/opencv.js?url";

type CV = {
  [key: string]: unknown;
  onRuntimeInitialized?: () => void;
};

let _cv: CV | null = null;

/**
 * OpenCV's emscripten Module is thenable (it exposes `.then` so `await cv`
 * works as an init-alias). Returning it directly from an async function
 * makes Promise.resolve adopt its thenable state, which never settles and
 * hangs the awaiter forever. Wrapping in a plain object defeats adoption.
 */
async function loadOpenCv(): Promise<{ cv: CV }> {
  if (_cv) return { cv: _cv };
  const res = await fetch(opencvUrl);
  if (!res.ok) throw new Error(`failed to fetch opencv (${res.status})`);
  const code = await res.text();
  new Function("self", code)(self);
  const cv = (self as unknown as { cv: CV }).cv;
  if (!cv) throw new Error("opencv failed to attach to self.cv");
  if (typeof (cv as { getBuildInformation?: () => string }).getBuildInformation !== "function") {
    await new Promise<void>((resolve) => {
      cv.onRuntimeInitialized = () => resolve();
    });
  }
  _cv = cv;
  return { cv };
}

export interface PreprocessInput {
  pngBytes: ArrayBuffer;
  pageIndex: number;
  deskew: boolean;
  binarizer: "sauvola" | "otsu";
  denoiseRadius: number;
}

export interface PreprocessOutput {
  pageIndex: number;
  pngBytes: ArrayBuffer;
  width: number;
  height: number;
  thumbnailDataUrl: string;
  skewAngleDegrees: number;
}

const THUMB_MAX_SIDE = 160;

async function decodePng(bytes: ArrayBuffer): Promise<ImageData> {
  const blob = new Blob([bytes], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d ctx unavailable");
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

function makeImageData(data: Uint8ClampedArray, w: number, h: number): ImageData {
  const buf = new ArrayBuffer(data.byteLength);
  const view = new Uint8ClampedArray(buf);
  view.set(data);
  return new ImageData(view, w, h);
}

async function encodePng(data: Uint8ClampedArray, w: number, h: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d ctx unavailable");
  ctx.putImageData(makeImageData(data, w, h), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

async function encodeThumbnail(data: Uint8ClampedArray, w: number, h: number): Promise<string> {
  const scale = Math.min(1, THUMB_MAX_SIDE / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const full = new OffscreenCanvas(w, h);
  const ctx = full.getContext("2d");
  if (!ctx) throw new Error("2d ctx unavailable");
  ctx.putImageData(makeImageData(data, w, h), 0, 0);
  const thumb = new OffscreenCanvas(tw, th);
  const thumbCtx = thumb.getContext("2d");
  if (!thumbCtx) throw new Error("2d ctx unavailable");
  thumbCtx.imageSmoothingEnabled = true;
  thumbCtx.drawImage(full, 0, 0, tw, th);
  const blob = await thumb.convertToBlob({ type: "image/png" });
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as number[]);
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CvAny = any;

/**
 * Measure the dominant horizontal-text skew angle (in degrees) via
 * HoughLinesP. @techstark/opencv-js omits findNonZero so we avoid the
 * minAreaRect-on-nonzero-points trick and work directly off edges.
 */
function measureSkewFromGray(cv: CvAny, gray: CvAny): number {
  const inverted = new cv.Mat();
  cv.bitwise_not(gray, inverted);
  const binary = new cv.Mat();
  cv.threshold(inverted, binary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
  const edges = new cv.Mat();
  const lines = new cv.Mat();
  try {
    cv.Canny(binary, edges, 50, 150, 3, false);
    const minLineLen = Math.max(40, Math.floor(Math.min(gray.cols, gray.rows) * 0.1));
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 80, minLineLen, 20);
    const angles: number[] = [];
    for (let i = 0; i < lines.rows; i++) {
      const base = i * 4;
      const x1 = lines.data32S[base];
      const y1 = lines.data32S[base + 1];
      const x2 = lines.data32S[base + 2];
      const y2 = lines.data32S[base + 3];
      let angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      if (Math.abs(angle) < 30) angles.push(angle);
    }
    if (angles.length === 0) return 0;
    angles.sort((a, b) => a - b);
    return angles[Math.floor(angles.length / 2)] ?? 0;
  } finally {
    inverted.delete();
    binary.delete();
    edges.delete();
    lines.delete();
  }
}

function rotate(cv: CvAny, gray: CvAny, angleDeg: number): CvAny {
  const center = new cv.Point(gray.cols / 2, gray.rows / 2);
  const rot = cv.getRotationMatrix2D(center, angleDeg, 1);
  const dst = new cv.Mat();
  const dsize = new cv.Size(gray.cols, gray.rows);
  cv.warpAffine(
    gray,
    dst,
    rot,
    dsize,
    cv.INTER_CUBIC,
    cv.BORDER_CONSTANT,
    new cv.Scalar(255, 255, 255, 255),
  );
  rot.delete();
  return dst;
}

function sauvolaBinarize(cv: CvAny, gray: CvAny, window: number, k: number): CvAny {
  const dst = new cv.Mat(gray.rows, gray.cols, cv.CV_8UC1);
  const floatSrc = new cv.Mat();
  gray.convertTo(floatSrc, cv.CV_32F);
  try {
    const mean = new cv.Mat();
    const sqMean = new cv.Mat();
    const sqSrc = new cv.Mat();
    try {
      cv.boxFilter(
        floatSrc,
        mean,
        cv.CV_32F,
        new cv.Size(window, window),
        new cv.Point(-1, -1),
        true,
        cv.BORDER_REPLICATE,
      );
      cv.multiply(floatSrc, floatSrc, sqSrc);
      cv.boxFilter(
        sqSrc,
        sqMean,
        cv.CV_32F,
        new cv.Size(window, window),
        new cv.Point(-1, -1),
        true,
        cv.BORDER_REPLICATE,
      );
      const rows = gray.rows;
      const cols = gray.cols;
      const meanData = mean.data32F;
      const sqMeanData = sqMean.data32F;
      const srcData = gray.data;
      const dstData = dst.data;
      const R = 128;
      for (let i = 0, n = rows * cols; i < n; i++) {
        const m = meanData[i] ?? 0;
        const variance = Math.max(0, (sqMeanData[i] ?? 0) - m * m);
        const stddev = Math.sqrt(variance);
        const threshold = m * (1 + k * (stddev / R - 1));
        dstData[i] = (srcData[i] ?? 0) > threshold ? 255 : 0;
      }
    } finally {
      mean.delete();
      sqMean.delete();
      sqSrc.delete();
    }
  } finally {
    floatSrc.delete();
  }
  return dst;
}

function grayToRgba(gray: Uint8Array, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i] ?? 0;
    out[i * 4 + 0] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

const api = {
  async measureSkew(pngBytes: ArrayBuffer): Promise<number> {
    const { cv } = (await loadOpenCv()) as { cv: CvAny };
    const imageData = await decodePng(pngBytes);
    const src = cv.matFromImageData(imageData);
    const gray = new cv.Mat();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      return measureSkewFromGray(cv, gray);
    } finally {
      src.delete();
      gray.delete();
    }
  },

  async preprocess(input: PreprocessInput): Promise<PreprocessOutput> {
    const { cv } = (await loadOpenCv()) as { cv: CvAny };
    const imageData = await decodePng(input.pngBytes);
    const src = cv.matFromImageData(imageData);
    let work: CvAny | null = null;
    let skewAngleDegrees = 0;
    try {
      work = new cv.Mat();
      cv.cvtColor(src, work, cv.COLOR_RGBA2GRAY);

      if (input.denoiseRadius > 0) {
        const radius = input.denoiseRadius * 2 + 1;
        const tmp = new cv.Mat();
        cv.medianBlur(work, tmp, radius);
        work.delete();
        work = tmp;
      }

      if (input.deskew) {
        skewAngleDegrees = measureSkewFromGray(cv, work);
        if (Math.abs(skewAngleDegrees) > 0.05) {
          const rotated = rotate(cv, work, skewAngleDegrees);
          work.delete();
          work = rotated;
        }
      }

      let binary: CvAny;
      if (input.binarizer === "otsu") {
        binary = new cv.Mat();
        cv.threshold(work, binary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
      } else {
        binary = sauvolaBinarize(cv, work, 25, 0.2);
      }
      work.delete();
      work = binary;

      const width = work.cols;
      const height = work.rows;
      const grayBytes = new Uint8Array(work.data);
      const rgba = grayToRgba(grayBytes, width, height);
      const [pngBytes, thumbnailDataUrl] = await Promise.all([
        encodePng(rgba, width, height),
        encodeThumbnail(rgba, width, height),
      ]);

      const transferable = new ArrayBuffer(pngBytes.byteLength);
      new Uint8Array(transferable).set(pngBytes);
      return Comlink.transfer(
        {
          pageIndex: input.pageIndex,
          pngBytes: transferable,
          width,
          height,
          thumbnailDataUrl,
          skewAngleDegrees,
        },
        [transferable],
      );
    } finally {
      work?.delete();
      src.delete();
    }
  },
};

export type PreprocessWorkerApi = typeof api;

Comlink.expose(api);
