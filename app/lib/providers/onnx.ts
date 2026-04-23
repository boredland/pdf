import * as ort from "onnxruntime-web";
import type { OcrLine, OcrProvider, OcrResult, OcrWord, RecognizeInput } from "./types";

const MODELS = {
  det: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.3.0/onnx/PP-OCRv4/det/en_PP-OCRv3_det_infer.onnx",
  rec: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.3.0/onnx/PP-OCRv4/rec/en_PP-OCRv4_rec_infer.onnx",
  dict: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.3.0/paddle/PP-OCRv4/rec/en_PP-OCRv4_rec_infer/en_dict.txt",
} as const;

const SUPPORTED_LANGS = new Set(["eng"]);
const DET_LIMIT = 736;
const DET_THRESH = 0.3;
const REC_HEIGHT = 48;
const REC_WIDTH = 320;
const DET_MIN_AREA = 20;
const REC_SCORE_MIN = 0.25;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

let detSessionPromise: Promise<ort.InferenceSession> | null = null;
let recSessionPromise: Promise<ort.InferenceSession> | null = null;
let dictPromise: Promise<string[]> | null = null;

async function getDetSession() {
  detSessionPromise ??= ort.InferenceSession.create(MODELS.det, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  return detSessionPromise;
}

async function getRecSession() {
  recSessionPromise ??= ort.InferenceSession.create(MODELS.rec, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  return recSessionPromise;
}

async function getDictionary() {
  dictPromise ??= fetch(MODELS.dict)
    .then((res) => {
      if (!res.ok) throw new Error(`failed to load OCR dictionary (${res.status})`);
      return res.text();
    })
    .then((text) => ["", ...text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)]);
  return dictPromise;
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

function resizeForDetection(
  image: ImageData,
): { image: ImageData; ratioW: number; ratioH: number } {
  const srcW = image.width;
  const srcH = image.height;
  let ratio = 1;
  if (Math.max(srcW, srcH) > DET_LIMIT) {
    ratio = DET_LIMIT / Math.max(srcW, srcH);
  }
  let dstW = Math.max(32, Math.ceil((srcW * ratio) / 32) * 32);
  let dstH = Math.max(32, Math.ceil((srcH * ratio) / 32) * 32);
  const canvas = new OffscreenCanvas(dstW, dstH);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const src = new OffscreenCanvas(srcW, srcH);
  const srcCtx = src.getContext("2d");
  if (!srcCtx) throw new Error("2d context unavailable");
  srcCtx.putImageData(image, 0, 0);
  ctx.drawImage(src, 0, 0, srcW, srcH, 0, 0, dstW, dstH);
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

function connectedBoxes(prob: Float32Array, w: number, h: number): Box[] {
  const bitmap = new Uint8Array(w * h);
  for (let i = 0; i < bitmap.length; i++) bitmap[i] = (prob[i] ?? 0) > DET_THRESH ? 1 : 0;
  const visited = new Uint8Array(bitmap.length);
  const boxes: Box[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (!bitmap[start] || visited[start]) continue;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      const stack: Array<[number, number]> = [[x, y]];
      while (stack.length) {
        const [cx, cy] = stack.pop() as [number, number];
        const idx = cy * w + cx;
        if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
        if (!bitmap[idx] || visited[idx]) continue;
        visited[idx] = 1;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
      }
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      if (bw * bh >= DET_MIN_AREA && bw > 5 && bh > 5) {
        const pad = Math.round(bh * 0.3);
        boxes.push({
          x: Math.max(0, minX - pad),
          y: Math.max(0, minY - pad),
          width: Math.min(w - minX, bw + pad * 2),
          height: Math.min(h - minY, bh + pad * 2),
        });
      }
    }
  }
  return boxes;
}

async function detectRegions(image: ImageData): Promise<Box[]> {
  const session = await getDetSession();
  const { image: resized, ratioW, ratioH } = resizeForDetection(image);
  const input = toDetTensor(resized);
  const out = await session.run({ [session.inputNames[0] as string]: input });
  const first = out[Object.keys(out)[0] as string] as ort.Tensor;
  const dims = first.dims;
  const data = first.data as Float32Array;
  const h = dims[dims.length - 2] as number;
  const w = dims[dims.length - 1] as number;
  const boxes = connectedBoxes(data, w, h);
  return boxes.map((b) => ({
    x: Math.round(b.x / ratioW),
    y: Math.round(b.y / ratioH),
    width: Math.round(b.width / ratioW),
    height: Math.round(b.height / ratioH),
  }));
}

function crop(src: ImageData, box: Box): ImageData {
  const canvas = new OffscreenCanvas(box.width, box.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const source = new OffscreenCanvas(src.width, src.height);
  const sctx = source.getContext("2d");
  if (!sctx) throw new Error("2d context unavailable");
  sctx.putImageData(src, 0, 0);
  ctx.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
  return ctx.getImageData(0, 0, box.width, box.height);
}

function toRecTensor(image: ImageData): ort.Tensor {
  const scale = REC_HEIGHT / image.height;
  const targetW = Math.max(8, Math.min(REC_WIDTH, Math.round(image.width * scale)));
  const canvas = new OffscreenCanvas(targetW, REC_HEIGHT);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const source = new OffscreenCanvas(image.width, image.height);
  const sctx = source.getContext("2d");
  if (!sctx) throw new Error("2d context unavailable");
  sctx.putImageData(image, 0, 0);
  ctx.drawImage(source, 0, 0, image.width, image.height, 0, 0, targetW, REC_HEIGHT);
  const resized = ctx.getImageData(0, 0, targetW, REC_HEIGHT).data;
  const out = new Float32Array(3 * REC_HEIGHT * REC_WIDTH);
  for (let y = 0; y < REC_HEIGHT; y++) {
    for (let x = 0; x < targetW; x++) {
      const px = (y * targetW + x) * 4;
      const i = y * REC_WIDTH + x;
      out[i] = (((resized[px] ?? 0) / 255) - 0.5) / 0.5;
      out[REC_HEIGHT * REC_WIDTH + i] = (((resized[px + 1] ?? 0) / 255) - 0.5) / 0.5;
      out[2 * REC_HEIGHT * REC_WIDTH + i] = (((resized[px + 2] ?? 0) / 255) - 0.5) / 0.5;
    }
  }
  return new ort.Tensor("float32", out, [1, 3, REC_HEIGHT, REC_WIDTH]);
}

function decodeCtc(output: ort.Tensor, dict: string[]): { text: string; confidence: number } {
  const data = output.data as Float32Array;
  const dims = output.dims;
  const seqLen = dims[1] as number;
  const vocab = dims[2] as number;
  let prev = -1;
  const chars: string[] = [];
  const probs: number[] = [];
  for (let t = 0; t < seqLen; t++) {
    let maxIdx = 0;
    let maxVal = -Infinity;
    for (let c = 0; c < vocab; c++) {
      const v = data[t * vocab + c] as number;
      if (v > maxVal) {
        maxVal = v;
        maxIdx = c;
      }
    }
    if (maxIdx !== 0 && maxIdx !== prev && dict[maxIdx]) {
      chars.push(dict[maxIdx] as string);
      probs.push(maxVal);
    }
    prev = maxIdx;
  }
  const text = chars.join("").trim();
  const confidence = probs.length
    ? probs.reduce((sum, p) => sum + p, 0) / probs.length
    : 0;
  return { text, confidence };
}

function toWordLine(text: string, confidence: number, box: Box): { word: OcrWord; line: OcrLine } {
  const word: OcrWord = {
    text,
    confidence,
    bbox: box,
  };
  const line: OcrLine = {
    text,
    bbox: box,
    words: [word],
  };
  return { word, line };
}

export const onnxProvider: OcrProvider = {
  id: "onnx-paddle",
  label: "ONNX PaddleOCR (on-device, experimental)",
  kind: "local",
  capabilities: { layout: true, tables: false, handwriting: false },
  async isAvailable() {
    return true;
  },
  async recognize(input: RecognizeInput): Promise<OcrResult> {
    if (!SUPPORTED_LANGS.has(input.language)) {
      throw new Error("onnx-paddle currently supports only `eng` language");
    }
    const [recSession, dict] = await Promise.all([getRecSession(), getDictionary()]);
    const image = await decodePng(input.pngBytes);
    const pageSize = { width: image.width, height: image.height };
    const regions = await detectRegions(image);
    const sorted = regions.sort((a, b) => (Math.abs(a.y - b.y) < 10 ? a.x - b.x : a.y - b.y));
    const words: OcrWord[] = [];
    const lines: OcrLine[] = [];
    const fullText: string[] = [];
    for (const region of sorted) {
      if (input.signal?.aborted) throw new Error("aborted");
      const recInput = toRecTensor(crop(image, region));
      const out = await recSession.run({ [recSession.inputNames[0] as string]: recInput });
      const recOut = out[Object.keys(out)[0] as string] as ort.Tensor;
      const decoded = decodeCtc(recOut, dict);
      if (!decoded.text || decoded.confidence < REC_SCORE_MIN) continue;
      const { word, line } = toWordLine(decoded.text, decoded.confidence, region);
      words.push(word);
      lines.push(line);
      fullText.push(decoded.text);
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
  async dispose() {
    detSessionPromise = null;
    recSessionPromise = null;
    dictPromise = null;
  },
};
