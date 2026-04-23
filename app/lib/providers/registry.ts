import type { OcrProvider } from "./types";
import { tesseractProvider } from "./tesseract";
import { onnxProvider } from "./onnx";
import { geminiProvider } from "./gemini";
import { mistralProvider } from "./mistral";

// The mock provider (app/lib/providers/mock.ts) is NOT listed here. The
// test harness registers it lazily when a spec opts in — keeps it out of
// prod bundles' provider dropdown.
const PROVIDERS: OcrProvider[] = [
  tesseractProvider,
  onnxProvider,
  geminiProvider,
  mistralProvider,
];

export function listProviders(): OcrProvider[] {
  return [...PROVIDERS];
}

export function getProvider(id: string): OcrProvider {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) throw new Error(`unknown OCR provider: ${id}`);
  return provider;
}

export function registerProvider(provider: OcrProvider): void {
  const existing = PROVIDERS.findIndex((p) => p.id === provider.id);
  if (existing >= 0) PROVIDERS[existing] = provider;
  else PROVIDERS.push(provider);
}
