import * as Comlink from "comlink";
import type { MrcInput, MrcWorkerApi } from "~/workers/mrc.worker";

interface Slot {
  worker: Worker;
  api: Comlink.Remote<MrcWorkerApi>;
  busy: boolean;
}

let slots: Slot[] | null = null;

function poolSize(): number {
  const hw = typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? 4 : 2;
  return Math.min(3, Math.max(1, hw - 2));
}

function ensurePool(): Slot[] {
  if (slots) return slots;
  const size = poolSize();
  slots = Array.from({ length: size }, () => {
    const worker = new Worker(new URL("../../workers/mrc.worker.ts", import.meta.url), {
      type: "module",
    });
    const api = Comlink.wrap<MrcWorkerApi>(worker);
    return { worker, api, busy: false };
  });
  if (typeof window !== "undefined") {
    (window as typeof window & { __pdfMrcCallCount?: number }).__pdfMrcCallCount ??= 0;
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

export async function splitMrc(input: MrcInput) {
  const slot = await waitForSlot();
  slot.busy = true;
  try {
    if (typeof window !== "undefined") {
      const w = window as typeof window & { __pdfMrcCallCount?: number };
      w.__pdfMrcCallCount = (w.__pdfMrcCallCount ?? 0) + 1;
    }
    return await slot.api.split(input);
  } finally {
    slot.busy = false;
  }
}

export function tearDownMrcPool(): void {
  if (!slots) return;
  for (const { worker } of slots) worker.terminate();
  slots = null;
}
