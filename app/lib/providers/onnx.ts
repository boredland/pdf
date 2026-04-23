import { disposeOnnxOcrWorker, recognizeWithOnnx } from "~/lib/workers/onnx-ocr-client";
import type { OcrProvider, OcrResult, RecognizeInput } from "./types";

const SUPPORTED_LANGS = new Set(["eng"]);

export const onnxProvider: OcrProvider = {
  id: "onnx-paddle",
  label: "ONNX PaddleOCR (on-device)",
  kind: "local",
  capabilities: { layout: true, tables: false, handwriting: false },
  async isAvailable() {
    return true;
  },
  async recognize(input: RecognizeInput): Promise<OcrResult> {
    if (!SUPPORTED_LANGS.has(input.language)) {
      throw new Error("onnx-paddle currently supports only `eng` language");
    }
    return recognizeWithOnnx(input);
  },
  async dispose() {
    await disposeOnnxOcrWorker();
  },
};
