/// <reference lib="webworker" />
import * as Comlink from "comlink";
import * as ort from "onnxruntime-web";
import type {
  OcrLine,
  OcrResult,
  OcrWord,
  ProviderProgress,
} from "~/lib/providers/types";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OnnxWorkerRecognizeInput {
  pngBytes: ArrayBuffer;
  pageIndex: number;
  language: string;
  regions?: Box[];
  onProgress?: (progress: ProviderProgress) => void;
}

export interface OnnxOcrWorkerApi {
  recognize(input: OnnxWorkerRecognizeInput): Promise<OcrResult>;
  dispose(): Promise<void>;
}

const MODELS = {
  det: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.8.0/onnx/PP-OCRv5/det/ch_PP-OCRv5_det_mobile.onnx",
  rec: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.8.0/onnx/PP-OCRv5/rec/en_PP-OCRv5_rec_mobile.onnx",
  cls: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.8.0/onnx/PP-OCRv5/cls/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx",
  dict: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.8.0/paddle/PP-OCRv5/rec/en_PP-OCRv5_rec_mobile/ppocrv5_en_dict.txt",
} as const;

const SUPPORTED_LANGS = new Set(["eng"]);
const DET_LIMIT = 736;
const DET_THRESH = 0.3;
const DET_BOX_THRESH = 0.55;
const DET_MIN_AREA = 20;
const MAX_REGIONS = 180;
const REC_HEIGHT = 48;
const REC_WIDTH = 320;
const CLS_WIDTH = 160;
const CLS_HEIGHT = 80;
const REC_SCORE_MIN = 0.35;
const CLS_SCORE_MIN = 0.9;
const CLS_LABELS = ["0", "180"] as const;

let ortConfigured = false;
let detSessionPromise: Promise<ort.InferenceSession> | null = null;
let recSessionPromise: Promise<ort.InferenceSession> | null = null;
let clsSessionPromise: Promise<ort.InferenceSession> | null = null;
let dictPromise: Promise<string[]> | null = null;

function configureOrt(): void {
  if (ortConfigured) return;
  ort.env.wasm.numThreads = Math.max(1, Math.min(4, navigator.hardwareConcurrency ?? 1));
  ort.env.wasm.simd = true;
  ortConfigured = true;
}

async function createSession(url: string): Promise<ort.InferenceSession> {
  configureOrt();
  const executionProviders: ort.InferenceSession.SessionOptions["executionProviders"][] = [
    ["webgl"],
    ["wasm"],
  ];
  let lastError: unknown = null;
  for (const providers of executionProviders) {
    try {
      return await ort.InferenceSession.create(url, {
        executionProviders: providers,
        graphOptimizationLevel: "all",
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`failed to load ONNX model: ${url}`);
}

async function getDetSession() {
  detSessionPromise ??= createSession(MODELS.det);
  return detSessionPromise;
}

async function getRecSession() {
  recSessionPromise ??= createSession(MODELS.rec);
  return recSessionPromise;
}

async function getClsSession() {
  clsSessionPromise ??= createSession(MODELS.cls);
  return clsSessionPromise;
}

async function getDictionary() {
  dictPromise ??= fetch(MODELS.dict)
    .then((response) => {
      if (!response.ok) throw new Error(`failed to load OCR dictionary (${response.status})`);
      return response.text();
    })
    .then((text) => ["", ...text.split(/\n/).map((line) => line.replace(/\r$/, "")).filter(Boolean)]);
  return dictPromise;
}

function reportProgress(
  input: OnnxWorkerRecognizeInput,
  ratio: number,
  label: string,
): void {
  input.onProgress?.({ ratio, label });
}

async function decodePng(bytes: ArrayBuffer): Promise<ImageData> {
  const blob = new Blob([bytes], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function imageDataToCanvas(image: ImageData, width = image.width, height = image.height): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function crop(src: ImageData, box: Box): ImageData {
  const canvas = new OffscreenCanvas(box.width, box.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const source = imageDataToCanvas(src);
  ctx.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
  return ctx.getImageData(0, 0, box.width, box.height);
}

function rotate180(image: ImageData): ImageData {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const source = imageDataToCanvas(image);
  ctx.translate(image.width, image.height);
  ctx.rotate(Math.PI);
  ctx.drawImage(source, 0, 0);
  return ctx.getImageData(0, 0, image.width, image.height);
}

function resizeForDetection(image: ImageData): { image: ImageData; ratioW: number; ratioH: number } {
  const srcW = image.width;
  const srcH = image.height;
  const ratio = Math.max(srcW, srcH) > DET_LIMIT ? DET_LIMIT / Math.max(srcW, srcH) : 1;
  const dstW = Math.max(32, Math.ceil((srcW * ratio) / 32) * 32);
  const dstH = Math.max(32, Math.ceil((srcH * ratio) / 32) * 32);
  const canvas = new OffscreenCanvas(dstW, dstH);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(imageDataToCanvas(image), 0, 0, srcW, srcH, 0, 0, dstW, dstH);
  return {
    image: ctx.getImageData(0, 0, dstW, dstH),
    ratioW: dstW / srcW,
    ratioH: dstH / srcH,
  };
}

function toDetTensor(image: ImageData): ort.Tensor {
  const { width, height, data } = image;
  const out = new Float32Array(3 * width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = (y * width + x) * 4;
      const i = y * width + x;
      out[i] = (((data[px] ?? 0) / 255) - 0.5) / 0.5;
      out[width * height + i] = (((data[px + 1] ?? 0) / 255) - 0.5) / 0.5;
      out[2 * width * height + i] = (((data[px + 2] ?? 0) / 255) - 0.5) / 0.5;
    }
  }
  return new ort.Tensor("float32", out, [1, 3, height, width]);
}

function dilate(bitmap: Uint8Array, width: number, height: number): void {
  const source = new Uint8Array(bitmap);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (source[idx]) continue;
      let on = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny < 0 || nx < 0 || ny >= height || nx >= width) continue;
          if (source[ny * width + nx]) on++;
        }
      }
      if (on >= 2) bitmap[idx] = 1;
    }
  }
}

function mergeLineBoxes(boxes: Box[]): Box[] {
  const sorted = [...boxes].sort((a, b) => (Math.abs(a.y - b.y) < 8 ? a.x - b.x : a.y - b.y));
  const merged: Box[] = [];
  for (const box of sorted) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({ ...box });
      continue;
    }
    const yOverlap =
      Math.max(0, Math.min(last.y + last.height, box.y + box.height) - Math.max(last.y, box.y));
    const minH = Math.min(last.height, box.height);
    const gap = box.x - (last.x + last.width);
    const sameLine = yOverlap > minH * 0.45 && gap >= -8 && gap < Math.max(24, minH * 1.2);
    if (!sameLine) {
      merged.push({ ...box });
      continue;
    }
    const x1 = Math.min(last.x, box.x);
    const y1 = Math.min(last.y, box.y);
    const x2 = Math.max(last.x + last.width, box.x + box.width);
    const y2 = Math.max(last.y + last.height, box.y + box.height);
    last.x = x1;
    last.y = y1;
    last.width = x2 - x1;
    last.height = y2 - y1;
  }
  return merged;
}

function connectedBoxes(probabilities: Float32Array, width: number, height: number, rawW: number, rawH: number): Box[] {
  const bitmap = new Uint8Array(width * height);
  for (let i = 0; i < bitmap.length; i++) {
    bitmap[i] = (probabilities[i] ?? 0) > DET_THRESH ? 1 : 0;
  }
  dilate(bitmap, width, height);
  const visited = new Uint8Array(bitmap.length);
  const boxes: Box[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (!bitmap[start] || visited[start]) continue;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      const stack: Array<[number, number]> = [[x, y]];
      while (stack.length) {
        const [cx, cy] = stack.pop() as [number, number];
        if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
        const idx = cy * width + cx;
        if (!bitmap[idx] || visited[idx]) continue;
        visited[idx] = 1;
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);
        stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
      }
      const boxWidth = maxX - minX + 1;
      const boxHeight = maxY - minY + 1;
      if (boxWidth * boxHeight < DET_MIN_AREA || boxWidth <= 5 || boxHeight <= 5) continue;
      let scoreSum = 0;
      let scoreCount = 0;
      for (let yy = minY; yy <= maxY; yy++) {
        for (let xx = minX; xx <= maxX; xx++) {
          scoreSum += probabilities[yy * width + xx] ?? 0;
          scoreCount++;
        }
      }
      const score = scoreCount > 0 ? scoreSum / scoreCount : 0;
      if (score < DET_BOX_THRESH) continue;
      const pad = Math.round(boxHeight * 0.3);
      boxes.push({
        x: Math.max(0, minX - pad),
        y: Math.max(0, minY - pad),
        width: Math.min(width - minX, boxWidth + pad * 2),
        height: Math.min(height - minY, boxHeight + pad * 2),
      });
    }
  }
  const scaled = boxes.map((box) => ({
    x: Math.max(0, Math.min(rawW - 1, box.x)),
    y: Math.max(0, Math.min(rawH - 1, box.y)),
    width: Math.max(1, Math.min(rawW, box.width)),
    height: Math.max(1, Math.min(rawH, box.height)),
  }));
  return mergeLineBoxes(scaled);
}

async function detectRegions(image: ImageData): Promise<Box[]> {
  const session = await getDetSession();
  const { image: resized, ratioW, ratioH } = resizeForDetection(image);
  const input = toDetTensor(resized);
  const output = await session.run({ [session.inputNames[0] as string]: input });
  const first = output[Object.keys(output)[0] as string] as ort.Tensor;
  const dims = first.dims;
  const data = first.data as Float32Array;
  const height = dims[dims.length - 2] as number;
  const width = dims[dims.length - 1] as number;
  return connectedBoxes(data, width, height, resized.width, resized.height)
    .map((box) => ({
      x: Math.round(box.x / ratioW),
      y: Math.round(box.y / ratioH),
      width: Math.round(box.width / ratioW),
      height: Math.round(box.height / ratioH),
    }))
    .slice(0, MAX_REGIONS);
}

function renderResized(image: ImageData, targetWidth: number, targetHeight: number, background = "#ffffff"): ImageData {
  const canvas = new OffscreenCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(imageDataToCanvas(image), 0, 0, image.width, image.height, 0, 0, targetWidth, targetHeight);
  return ctx.getImageData(0, 0, targetWidth, targetHeight);
}

function toClsTensor(image: ImageData): ort.Tensor {
  const ratio = image.width / Math.max(1, image.height);
  const targetWidth = Math.max(8, Math.min(CLS_WIDTH, Math.round(CLS_HEIGHT * ratio)));
  const resized = renderResized(image, targetWidth, CLS_HEIGHT);
  const out = new Float32Array(3 * CLS_HEIGHT * CLS_WIDTH);
  out.fill(1);
  for (let y = 0; y < CLS_HEIGHT; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const px = (y * targetWidth + x) * 4;
      const i = y * CLS_WIDTH + x;
      out[i] = (((resized.data[px] ?? 0) / 255) - 0.5) / 0.5;
      out[CLS_HEIGHT * CLS_WIDTH + i] = (((resized.data[px + 1] ?? 0) / 255) - 0.5) / 0.5;
      out[2 * CLS_HEIGHT * CLS_WIDTH + i] = (((resized.data[px + 2] ?? 0) / 255) - 0.5) / 0.5;
    }
  }
  return new ort.Tensor("float32", out, [1, 3, CLS_HEIGHT, CLS_WIDTH]);
}

function toRecTensor(image: ImageData): ort.Tensor {
  const ratio = image.width / Math.max(1, image.height);
  const targetWidth = Math.max(8, Math.min(REC_WIDTH, Math.round(REC_HEIGHT * ratio)));
  const resized = renderResized(image, targetWidth, REC_HEIGHT);
  const out = new Float32Array(3 * REC_HEIGHT * REC_WIDTH);
  out.fill(1);
  for (let y = 0; y < REC_HEIGHT; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const px = (y * targetWidth + x) * 4;
      const i = y * REC_WIDTH + x;
      out[i] = (((resized.data[px] ?? 0) / 255) - 0.5) / 0.5;
      out[REC_HEIGHT * REC_WIDTH + i] = (((resized.data[px + 1] ?? 0) / 255) - 0.5) / 0.5;
      out[2 * REC_HEIGHT * REC_WIDTH + i] = (((resized.data[px + 2] ?? 0) / 255) - 0.5) / 0.5;
    }
  }
  return new ort.Tensor("float32", out, [1, 3, REC_HEIGHT, REC_WIDTH]);
}

function softmaxArgmax(values: Float32Array): { index: number; probability: number } {
  let maxValue = -Infinity;
  let maxIndex = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i] ?? -Infinity;
    if (value > maxValue) {
      maxValue = value;
      maxIndex = i;
    }
  }
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += Math.exp((values[i] ?? -Infinity) - maxValue);
  }
  return {
    index: maxIndex,
    probability: Math.exp((values[maxIndex] ?? -Infinity) - maxValue) / Math.max(sum, Number.EPSILON),
  };
}

async function classifyOrientation(image: ImageData): Promise<0 | 180> {
  const session = await getClsSession();
  const input = toClsTensor(image);
  const output = await session.run({ [session.inputNames[0] as string]: input });
  const first = output[Object.keys(output)[0] as string] as ort.Tensor;
  const data = first.data as Float32Array;
  const { index, probability } = softmaxArgmax(data);
  if ((CLS_LABELS[index] ?? "0") === "180" && probability >= CLS_SCORE_MIN) {
    return 180;
  }
  return 0;
}

function decodeCtc(output: ort.Tensor, dictionary: string[]): { text: string; confidence: number } {
  const data = output.data as Float32Array;
  const dims = output.dims;
  if (dims.length !== 3) return { text: "", confidence: 0 };
  const d1 = dims[1] as number;
  const d2 = dims[2] as number;
  const seqFirst = d2 >= dictionary.length * 0.7;
  const seqLen = seqFirst ? d1 : d2;
  const vocab = seqFirst ? d2 : d1;
  let prev = -1;
  const chars: string[] = [];
  const confidences: number[] = [];
  const row = new Float32Array(vocab);
  for (let t = 0; t < seqLen; t++) {
    for (let c = 0; c < vocab; c++) {
      row[c] = seqFirst ? data[t * vocab + c] ?? -Infinity : data[c * seqLen + t] ?? -Infinity;
    }
    const { index, probability } = softmaxArgmax(row);
    if (index !== 0 && index !== prev && dictionary[index]) {
      chars.push(dictionary[index] as string);
      confidences.push(probability);
    }
    prev = index;
  }
  const text = chars.join("").trim();
  const confidence = confidences.length
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : 0;
  return { text, confidence };
}

function sortRegions(regions: Box[]): Box[] {
  return [...regions].sort((a, b) => (Math.abs(a.y - b.y) < 10 ? a.x - b.x : a.y - b.y));
}

function toApproxWords(text: string, confidence: number, box: Box): OcrWord[] {
  const matches = [...text.matchAll(/\S+/g)];
  if (matches.length <= 1 || text.length === 0) {
    return [{ text, confidence, bbox: box }];
  }
  return matches.map((match) => {
    const token = match[0];
    const start = match.index ?? 0;
    const end = start + token.length;
    const startRatio = start / text.length;
    const endRatio = end / text.length;
    const x = box.x + Math.round(box.width * startRatio);
    const right = box.x + Math.round(box.width * endRatio);
    return {
      text: token,
      confidence,
      bbox: {
        x,
        y: box.y,
        width: Math.max(1, right - x),
        height: box.height,
      },
    };
  });
}

async function recognizeRegion(
  region: Box,
  pageImage: ImageData,
  recSession: ort.InferenceSession,
  dictionary: string[],
): Promise<{ line: OcrLine; words: OcrWord[] } | null> {
  const rawCrop = crop(pageImage, region);
  const angle = await classifyOrientation(rawCrop);
  const cropImage = angle === 180 ? rotate180(rawCrop) : rawCrop;
  const recInput = toRecTensor(cropImage);
  const output = await recSession.run({ [recSession.inputNames[0] as string]: recInput });
  const first = output[Object.keys(output)[0] as string] as ort.Tensor;
  const decoded = decodeCtc(first, dictionary);
  if (!decoded.text || decoded.confidence < REC_SCORE_MIN) return null;
  const words = toApproxWords(decoded.text, decoded.confidence, region);
  return {
    words,
    line: {
      text: decoded.text,
      bbox: region,
      words,
    },
  };
}

const api: OnnxOcrWorkerApi = {
  async recognize(input: OnnxWorkerRecognizeInput): Promise<OcrResult> {
    if (!SUPPORTED_LANGS.has(input.language)) {
      throw new Error("onnx-paddle currently supports only `eng` language");
    }
    reportProgress(input, 0.05, "loading models");
    const [recSession, dictionary] = await Promise.all([getRecSession(), getDictionary(), getClsSession()]);
    reportProgress(input, 0.15, "decoding page");
    const pageImage = await decodePng(input.pngBytes);
    const pageSize = { width: pageImage.width, height: pageImage.height };
    const regions = input.regions?.length ? input.regions : await detectRegions(pageImage);
    const sortedRegions = sortRegions(regions);
    const words: OcrWord[] = [];
    const lines: OcrLine[] = [];
    const fullText: string[] = [];
    if (sortedRegions.length === 0) {
      return {
        providerId: "onnx-paddle",
        pageSize,
        text: "",
        hocr: "",
        words,
        lines,
      };
    }
    for (let index = 0; index < sortedRegions.length; index++) {
      const recognized = await recognizeRegion(sortedRegions[index] as Box, pageImage, recSession, dictionary);
      reportProgress(
        input,
        0.15 + ((index + 1) / sortedRegions.length) * 0.85,
        `recognizing region ${index + 1}/${sortedRegions.length}`,
      );
      if (!recognized) continue;
      words.push(...recognized.words);
      lines.push(recognized.line);
      fullText.push(recognized.line.text);
    }
    return {
      providerId: "onnx-paddle",
      pageSize,
      text: fullText.join("\n"),
      hocr: "",
      words,
      lines,
    };
  },
  async dispose(): Promise<void> {
    detSessionPromise = null;
    recSessionPromise = null;
    clsSessionPromise = null;
    dictPromise = null;
  },
};

Comlink.expose(api);
