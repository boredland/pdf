import { createScheduler, createWorker, type Scheduler, type Worker } from "tesseract.js";
import { langPathFor } from "~/lib/languages";
import type {
  OcrLine,
  OcrProvider,
  OcrResult,
  OcrWord,
  RecognizeInput,
} from "./types";

const BASE = import.meta.env.BASE_URL;
const POOL_SIZE = 2;

interface SchedulerEntry {
  scheduler: Scheduler;
  workers: Worker[];
}

const schedulers = new Map<string, Promise<SchedulerEntry>>();

async function getScheduler(language: string): Promise<SchedulerEntry> {
  const existing = schedulers.get(language);
  if (existing) return existing;
  const { langPath, gzip } = langPathFor(language);
  const promise = (async () => {
    const scheduler = createScheduler();
    const workers: Worker[] = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const worker = await createWorker(language, 1, {
        corePath: `${BASE}tesseract/`,
        workerPath: `${BASE}tesseract/worker.min.js`,
        langPath,
        gzip,
      });
      workers.push(worker);
      scheduler.addWorker(worker);
    }
    return { scheduler, workers };
  })();
  schedulers.set(language, promise);
  return promise;
}

interface TesseractBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface TesseractWord {
  text: string;
  confidence: number;
  bbox: TesseractBbox;
}

interface TesseractLine {
  text: string;
  bbox: TesseractBbox;
  words?: TesseractWord[];
}

interface TesseractParagraph {
  lines?: TesseractLine[];
}

interface TesseractBlock {
  paragraphs?: TesseractParagraph[];
}

interface TesseractPageResult {
  data: {
    text: string;
    hocr?: string;
    blocks?: TesseractBlock[];
  };
}

function normaliseWord(w: TesseractWord): OcrWord {
  return {
    text: w.text,
    confidence: typeof w.confidence === "number" ? w.confidence / 100 : 0,
    bbox: {
      x: w.bbox.x0,
      y: w.bbox.y0,
      width: w.bbox.x1 - w.bbox.x0,
      height: w.bbox.y1 - w.bbox.y0,
    },
  };
}

function flattenBlocks(blocks: TesseractBlock[] | undefined): {
  words: OcrWord[];
  lines: OcrLine[];
} {
  const words: OcrWord[] = [];
  const lines: OcrLine[] = [];
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const lineWords = (line.words ?? []).map(normaliseWord);
        words.push(...lineWords);
        lines.push({
          text: line.text,
          bbox: {
            x: line.bbox.x0,
            y: line.bbox.y0,
            width: line.bbox.x1 - line.bbox.x0,
            height: line.bbox.y1 - line.bbox.y0,
          },
          words: lineWords,
        });
      }
    }
  }
  return { words, lines };
}

export const tesseractProvider: OcrProvider = {
  id: "tesseract",
  label: "Tesseract (on-device)",
  kind: "local",
  capabilities: { layout: true, tables: false, handwriting: false },
  async isAvailable() {
    return true;
  },
  async recognize(input: RecognizeInput): Promise<OcrResult> {
    const { scheduler } = await getScheduler(input.language);
    const blob = new Blob([input.pngBytes], { type: "image/png" });
    const bitmap = await createImageBitmap(blob);
    const pageSize = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    const jobResult = (await scheduler.addJob(
      "recognize",
      blob,
      { rotateAuto: false },
      { text: true, hocr: true, blocks: true } as never,
    )) as unknown as TesseractPageResult;
    const { words, lines } = flattenBlocks(jobResult.data.blocks);
    return {
      providerId: "tesseract",
      pageSize,
      text: jobResult.data.text,
      hocr: jobResult.data.hocr ?? "",
      words,
      lines,
    };
  },
  async dispose() {
    for (const promise of schedulers.values()) {
      const entry = await promise;
      await entry.scheduler.terminate();
    }
    schedulers.clear();
  },
};
