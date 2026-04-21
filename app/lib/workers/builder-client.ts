import * as Comlink from "comlink";
import type { BuilderInput, BuilderWorkerApi } from "~/workers/builder.worker";

let worker: Worker | null = null;
let api: Comlink.Remote<BuilderWorkerApi> | null = null;

function ensure(): Comlink.Remote<BuilderWorkerApi> {
  if (api) return api;
  worker = new Worker(new URL("../../workers/builder.worker.ts", import.meta.url), {
    type: "module",
  });
  api = Comlink.wrap<BuilderWorkerApi>(worker);
  if (typeof window !== "undefined") {
    (window as typeof window & { __pdfBuildCallCount?: number }).__pdfBuildCallCount ??= 0;
  }
  return api;
}

export async function buildPdf(input: BuilderInput) {
  const instance = ensure();
  if (typeof window !== "undefined") {
    const w = window as typeof window & { __pdfBuildCallCount?: number };
    w.__pdfBuildCallCount = (w.__pdfBuildCallCount ?? 0) + 1;
  }
  // Transfer the (potentially large) source PDF bytes to the worker so
  // we don't copy multi-MB buffers across the postMessage boundary.
  return instance.build(
    Comlink.transfer(input, [input.sourcePdfBytes]),
  );
}

export function tearDownBuilder(): void {
  if (worker) worker.terminate();
  worker = null;
  api = null;
}
