import type { OcrProvider } from "./types";
import { tesseractProvider } from "./tesseract";
import { geminiProvider } from "./gemini";
import { mockProvider } from "./mock";

const PROVIDERS: OcrProvider[] = [tesseractProvider, geminiProvider, mockProvider];

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
