import * as Comlink from "comlink";
import type { PreprocessInput, PreprocessWorkerApi } from "~/workers/preprocess.worker";

interface Slot {
  worker: Worker;
  api: Comlink.Remote<PreprocessWorkerApi>;
  busy: boolean;
}

let slots: Slot[] | null = null;

function desiredPoolSize(): number {
  const hw = typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? 4 : 2;
  return Math.min(4, Math.max(1, hw - 2));
}

function ensurePool(): Slot[] {
  if (slots) return slots;
  const size = desiredPoolSize();
  slots = Array.from({ length: size }, () => {
    const worker = new Worker(
      new URL("../../workers/preprocess.worker.ts", import.meta.url),
      { type: "module" },
    );
    const api = Comlink.wrap<PreprocessWorkerApi>(worker);
    return { worker, api, busy: false };
  });
  if (typeof window !== "undefined") {
    (window as typeof window & { __pdfPreprocessCallCount?: number })
      .__pdfPreprocessCallCount ??= 0;
  }
  return slots;
}

async function waitForSlot(): Promise<Slot> {
  while (true) {
    const pool = ensurePool();
    const slot = pool.find((s) => !s.busy);
    if (slot) return slot;
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function preprocessPage(input: PreprocessInput) {
  const slot = await waitForSlot();
  slot.busy = true;
  try {
    if (typeof window !== "undefined") {
      const w = window as typeof window & { __pdfPreprocessCallCount?: number };
      w.__pdfPreprocessCallCount = (w.__pdfPreprocessCallCount ?? 0) + 1;
    }
    return await slot.api.preprocess(input);
  } finally {
    slot.busy = false;
  }
}

export async function measureSkew(pngBytes: ArrayBuffer): Promise<number> {
  const slot = await waitForSlot();
  slot.busy = true;
  try {
    return await slot.api.measureSkew(pngBytes);
  } finally {
    slot.busy = false;
  }
}

export function tearDownPreprocessPool(): void {
  if (!slots) return;
  for (const { worker } of slots) worker.terminate();
  slots = null;
}
