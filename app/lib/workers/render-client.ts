import * as Comlink from "comlink";
import type { RenderWorkerApi } from "~/workers/render.worker";

interface WorkerSlot {
  worker: Worker;
  api: Comlink.Remote<RenderWorkerApi>;
  busy: boolean;
}

let slots: WorkerSlot[] | null = null;

function desiredPoolSize(): number {
  const hw = typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? 4 : 2;
  return Math.min(6, Math.max(2, hw - 1));
}

function ensurePool(): WorkerSlot[] {
  if (slots) return slots;
  const size = desiredPoolSize();
  slots = Array.from({ length: size }, () => {
    const worker = new Worker(
      new URL("../../workers/render.worker.ts", import.meta.url),
      { type: "module" },
    );
    const api = Comlink.wrap<RenderWorkerApi>(worker);
    return { worker, api, busy: false };
  });
  if (typeof window !== "undefined") {
    (window as typeof window & { __pdfRenderCallCount?: number }).__pdfRenderCallCount ??= 0;
  }
  return slots;
}

function acquire(): WorkerSlot | null {
  const pool = ensurePool();
  return pool.find((s) => !s.busy) ?? null;
}

async function waitForSlot(): Promise<WorkerSlot> {
  while (true) {
    const slot = acquire();
    if (slot) return slot;
    await new Promise((r) => setTimeout(r, 10));
  }
}

function countCall(): void {
  if (typeof window === "undefined") return;
  const w = window as typeof window & { __pdfRenderCallCount?: number };
  w.__pdfRenderCallCount = (w.__pdfRenderCallCount ?? 0) + 1;
}

export async function getPageCount(pdfBytes: ArrayBuffer): Promise<number> {
  const slot = await waitForSlot();
  slot.busy = true;
  try {
    countCall();
    return await slot.api.getPageCount(pdfBytes);
  } finally {
    slot.busy = false;
  }
}

export interface RenderResult {
  pageIndex: number;
  pngBytes: ArrayBuffer;
  width: number;
  height: number;
  thumbnailDataUrl: string;
}

export async function renderPage(
  pdfBytes: ArrayBuffer,
  pageIndex: number,
  dpi: number,
): Promise<RenderResult> {
  const slot = await waitForSlot();
  slot.busy = true;
  try {
    countCall();
    return (await slot.api.renderPage({ pdfBytes, pageIndex, dpi })) as RenderResult;
  } finally {
    slot.busy = false;
  }
}

export function tearDownRenderPool(): void {
  if (!slots) return;
  for (const { worker } of slots) worker.terminate();
  slots = null;
}
