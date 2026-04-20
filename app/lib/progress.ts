import type { Stage } from "~/lib/storage/db";

export interface StageProgressEvent {
  kind: "stage";
  projectId: string;
  pageIndex: number;
  stage: Stage;
  status: "queued" | "running" | "done" | "failed" | "aborted" | "cached";
  error?: string;
  thumbnail?: string;
  sizeBytes?: number;
  ts: number;
}

export interface StageCounterEvent {
  kind: "counter";
  name: string;
  value: number;
  ts: number;
}

export type ProgressEvent = StageProgressEvent | StageCounterEvent;

const CHANNEL = "pdf-ocr-progress";

export function progressChannel(): BroadcastChannel {
  return new BroadcastChannel(CHANNEL);
}

export function emitProgress(event: ProgressEvent): void {
  const ch = progressChannel();
  try {
    ch.postMessage(event);
  } finally {
    ch.close();
  }
}
