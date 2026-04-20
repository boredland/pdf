/// <reference lib="webworker" />
import * as Comlink from "comlink";
import { optimizeMaskPng } from "../lib/compression/optimize-mask";

export type MrcPreset = "lossless" | "archival" | "compact";

export interface MrcInput {
  renderPngBytes: ArrayBuffer;
  preprocessedPngBytes: ArrayBuffer;
  pageIndex: number;
  preset: MrcPreset;
  /** Rotate the render by this angle (degrees) before inpainting so mask
   * and background share the preprocessed (deskewed) coordinate system. */
  skewAngleDegrees?: number;
  /** OSD cardinal pre-rotation applied by preprocess (0 or 180). */
  osdAngleDegrees?: 0 | 180;
}

export interface MrcOutput {
  pageIndex: number;
  maskPngBytes: ArrayBuffer;
  bgImageBytes: ArrayBuffer;
  bgMimeType: string;
  composedBytes: ArrayBuffer;
  composedMimeType: string;
  width: number;
  height: number;
  bgWidth: number;
  bgHeight: number;
  originalBytes: number;
  maskThumbnailDataUrl: string;
  bgThumbnailDataUrl: string;
  composedThumbnailDataUrl: string;
  meanAbsoluteDifference: number;
}

const THUMB_MAX_SIDE = 160;

async function decodePng(bytes: ArrayBuffer): Promise<ImageBitmap> {
  const blob = new Blob([bytes], { type: "image/png" });
  return createImageBitmap(blob);
}

function toCanvas(bitmap: ImageBitmap): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d ctx unavailable");
  ctx.drawImage(bitmap, 0, 0);
  return { canvas, ctx };
}

function toCanvasRotated(
  bitmap: ImageBitmap,
  angleDegrees: number,
): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d ctx unavailable");
  // Fill with white so the out-of-bounds edges don't leak black corners.
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, bitmap.width, bitmap.height);
  ctx.translate(bitmap.width / 2, bitmap.height / 2);
  // OpenCV's getRotationMatrix2D(angle) rotates counter-clockwise for
  // positive angles; Canvas 2D's rotate(rad) goes clockwise. Preprocess
  // deskews via OpenCV — to reproduce the same transform on the canvas side
  // we negate the angle.
  ctx.rotate((-angleDegrees * Math.PI) / 180);
  ctx.translate(-bitmap.width / 2, -bitmap.height / 2);
  ctx.drawImage(bitmap, 0, 0);
  return { canvas, ctx };
}

async function rotate180Bitmap(bitmap: ImageBitmap): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d ctx unavailable");
  ctx.translate(bitmap.width, bitmap.height);
  ctx.rotate(Math.PI);
  ctx.drawImage(bitmap, 0, 0);
  return canvas.transferToImageBitmap();
}

async function encode(canvas: OffscreenCanvas, mime: string, quality?: number): Promise<Uint8Array> {
  const opts: ImageEncodeOptions = { type: mime };
  if (quality !== undefined) opts.quality = quality;
  const blob = await canvas.convertToBlob(opts);
  return new Uint8Array(await blob.arrayBuffer());
}

function makeImageData(data: Uint8ClampedArray, w: number, h: number): ImageData {
  const buf = new ArrayBuffer(data.byteLength);
  const view = new Uint8ClampedArray(buf);
  view.set(data);
  return new ImageData(view, w, h);
}

function extractMask(preprocess: ImageData, threshold = 128): Uint8Array {
  // preprocessed image has text pixels as near-zero gray. The mask is a
  // binary array where 1 = text pixel (opaque in PDF), 0 = background.
  const { data, width, height } = preprocess;
  const mask = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    mask[j] = (data[i] ?? 0) < threshold ? 1 : 0;
  }
  return mask;
}

function maskToRgba(mask: Uint8Array, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
    const v = mask[i] === 1 ? 0 : 255;
    out[j] = v;
    out[j + 1] = v;
    out[j + 2] = v;
    out[j + 3] = 255;
  }
  return out;
}

/**
 * Very simple "inpaint-ish" pass: for each masked pixel, sample the mean
 * color of the nearest unmasked pixels in a small window. This hides the
 * text glyphs in the background so JPEG compression doesn't waste bits
 * encoding high-frequency text edges. It's not real inpainting — for a
 * v1 scan-photograph background it's good enough.
 */
function inpaintBackground(
  render: ImageData,
  mask: Uint8Array,
  radius = 4,
): Uint8ClampedArray {
  const { data, width, height } = render;
  const out = new Uint8ClampedArray(data.length);
  out.set(data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (mask[p] !== 1) continue;
      let r = 0,
        g = 0,
        b = 0,
        count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const np = ny * width + nx;
          if (mask[np] === 1) continue;
          const base = np * 4;
          r += data[base] ?? 0;
          g += data[base + 1] ?? 0;
          b += data[base + 2] ?? 0;
          count++;
        }
      }
      const base = p * 4;
      if (count > 0) {
        out[base] = Math.round(r / count);
        out[base + 1] = Math.round(g / count);
        out[base + 2] = Math.round(b / count);
        out[base + 3] = 255;
      }
    }
  }
  return out;
}

function presetConfig(preset: MrcPreset) {
  switch (preset) {
    case "lossless":
      return { bgMime: "image/png" as const, bgQuality: undefined, bgScale: 1 };
    case "archival":
      return { bgMime: "image/jpeg" as const, bgQuality: 0.85, bgScale: 0.75 };
    case "compact":
      return { bgMime: "image/jpeg" as const, bgQuality: 0.5, bgScale: 0.5 };
  }
}

async function downsample(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  scale: number,
): Promise<{ canvas: OffscreenCanvas; width: number; height: number }> {
  if (scale === 1) {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(makeImageData(rgba, w, h), 0, 0);
    return { canvas, width: w, height: h };
  }
  const full = new OffscreenCanvas(w, h);
  full.getContext("2d")!.putImageData(makeImageData(rgba, w, h), 0, 0);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const small = new OffscreenCanvas(nw, nh);
  const ctx = small.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(full, 0, 0, nw, nh);
  return { canvas: small, width: nw, height: nh };
}

async function thumbnail(canvas: OffscreenCanvas): Promise<string> {
  const scale = Math.min(1, THUMB_MAX_SIDE / Math.max(canvas.width, canvas.height));
  const tw = Math.max(1, Math.round(canvas.width * scale));
  const th = Math.max(1, Math.round(canvas.height * scale));
  const out = new OffscreenCanvas(tw, th);
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingQuality = "medium";
  ctx.drawImage(canvas, 0, 0, tw, th);
  const blob = await out.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as number[]);
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

async function compose(
  bg: OffscreenCanvas,
  bgWidth: number,
  bgHeight: number,
  mask: Uint8Array,
  width: number,
  height: number,
): Promise<{ canvas: OffscreenCanvas; rgba: Uint8ClampedArray }> {
  const full = new OffscreenCanvas(width, height);
  const ctx = full.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bg, 0, 0, bgWidth, bgHeight, 0, 0, width, height);
  const img = ctx.getImageData(0, 0, width, height);
  const data = img.data;
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] !== 1) continue;
    const base = p * 4;
    data[base] = 0;
    data[base + 1] = 0;
    data[base + 2] = 0;
    data[base + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: full, rgba: new Uint8ClampedArray(data) };
}

function meanAbsoluteDifference(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  sampleStep = 4,
): number {
  let total = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 4 * sampleStep) {
    for (let c = 0; c < 3; c++) {
      total += Math.abs((a[i + c] ?? 0) - (b[i + c] ?? 0));
      count++;
    }
  }
  return total / count;
}

const api = {
  async split(input: MrcInput): Promise<MrcOutput> {
    const config = presetConfig(input.preset);
    const renderBitmap = await decodePng(input.renderPngBytes);
    const preBitmap = await decodePng(input.preprocessedPngBytes);
    // Preprocess deskews the image before binarizing; the mask we extract
    // lives in the deskewed coordinate system. To make mask + background
    // compose cleanly, apply the same rotation to the render first.
    // Stack: OSD cardinal flip (if any) → then fine skew.
    const osdBitmap =
      input.osdAngleDegrees === 180
        ? await rotate180Bitmap(renderBitmap)
        : renderBitmap;
    const skew = input.skewAngleDegrees ?? 0;
    const { ctx: renderCtx } =
      Math.abs(skew) > 0.05
        ? toCanvasRotated(osdBitmap, skew)
        : toCanvas(osdBitmap);
    const renderImg = renderCtx.getImageData(0, 0, renderBitmap.width, renderBitmap.height);
    const { canvas: preCanvas } = toCanvas(preBitmap);
    const preImg = preCanvas
      .getContext("2d")!
      .getImageData(0, 0, preBitmap.width, preBitmap.height);

    const width = renderBitmap.width;
    const height = renderBitmap.height;
    if (preBitmap.width !== width || preBitmap.height !== height) {
      throw new Error("preprocessed and render page dimensions disagree");
    }

    const mask = extractMask(preImg);
    const inpainted = inpaintBackground(renderImg, mask);
    const bgStage = await downsample(inpainted, width, height, config.bgScale);
    const bgBlob = await bgStage.canvas.convertToBlob({
      type: config.bgMime,
      quality: config.bgQuality,
    });
    const bgBytes = new Uint8Array(await bgBlob.arrayBuffer());

    const maskRgba = maskToRgba(mask, width, height);
    const maskCanvas = new OffscreenCanvas(width, height);
    maskCanvas.getContext("2d")!.putImageData(makeImageData(maskRgba, width, height), 0, 0);
    let maskPngBytes = await encode(maskCanvas, "image/png");
    
    // Optimize mask with pure black/white thresholding for better compression
    maskPngBytes = await optimizeMaskPng(maskPngBytes);

    const { canvas: composedCanvas, rgba: composedRgba } = await compose(
      bgStage.canvas,
      bgStage.width,
      bgStage.height,
      mask,
      width,
      height,
    );
    const composedBytes = await encode(composedCanvas, "image/png");

    const mad = meanAbsoluteDifference(renderImg.data, composedRgba);

    const [maskThumbnailDataUrl, bgThumbnailDataUrl, composedThumbnailDataUrl] = await Promise.all([
      thumbnail(maskCanvas),
      thumbnail(bgStage.canvas),
      thumbnail(composedCanvas),
    ]);

    const maskTransfer = new ArrayBuffer(maskPngBytes.byteLength);
    new Uint8Array(maskTransfer).set(maskPngBytes);
    const bgTransfer = new ArrayBuffer(bgBytes.byteLength);
    new Uint8Array(bgTransfer).set(bgBytes);
    const composedTransfer = new ArrayBuffer(composedBytes.byteLength);
    new Uint8Array(composedTransfer).set(composedBytes);

    return Comlink.transfer(
      {
        pageIndex: input.pageIndex,
        maskPngBytes: maskTransfer,
        bgImageBytes: bgTransfer,
        bgMimeType: config.bgMime,
        composedBytes: composedTransfer,
        composedMimeType: "image/png",
        width,
        height,
        bgWidth: bgStage.width,
        bgHeight: bgStage.height,
        originalBytes: input.renderPngBytes.byteLength,
        maskThumbnailDataUrl,
        bgThumbnailDataUrl,
        composedThumbnailDataUrl,
        meanAbsoluteDifference: mad,
      },
      [maskTransfer, bgTransfer, composedTransfer],
    );
  },
};

export type MrcWorkerApi = typeof api;

Comlink.expose(api);
