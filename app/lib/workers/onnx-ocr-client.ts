import * as Comlink from "comlink";
import type { OcrResult, ProviderProgress, RecognizeInput } from "~/lib/providers/types";
import type {
  OnnxOcrWorkerApi,
  OnnxWorkerRecognizeInput,
} from "~/workers/onnx-ocr.worker";

let worker: Worker | null = null;
let api: Comlink.Remote<OnnxOcrWorkerApi> | null = null;

function ensure(): Comlink.Remote<OnnxOcrWorkerApi> {
  if (api) return api;
  worker = new Worker(new URL("../../workers/onnx-ocr.worker.ts", import.meta.url), {
    type: "module",
  });
  api = Comlink.wrap<OnnxOcrWorkerApi>(worker);
  return api;
}

export async function recognizeWithOnnx(input: RecognizeInput): Promise<OcrResult> {
  if (input.signal?.aborted) throw new Error("aborted");
  const payload: OnnxWorkerRecognizeInput = {
    pngBytes: input.pngBytes,
    pageIndex: input.pageIndex,
    language: input.language,
    regions: input.regions,
    onProgress: input.onProgress
      ? Comlink.proxy((progress: ProviderProgress) => input.onProgress?.(progress))
      : undefined,
  };
  const result = await ensure().recognize(payload);
  if (input.signal?.aborted) throw new Error("aborted");
  return result;
}

export async function disposeOnnxOcrWorker(): Promise<void> {
  if (api) {
    await api.dispose();
  }
  worker?.terminate();
  worker = null;
  api = null;
}
