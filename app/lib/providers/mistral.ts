import { getApiKey, hasApiKey } from "~/lib/api-keys";
import type {
  OcrLine,
  OcrProvider,
  OcrResult,
  OcrWord,
  RecognizeInput,
} from "./types";

const ENDPOINT = "https://api.mistral.ai/v1/ocr";
const MODEL = "mistral-ocr-latest";

interface MistralOcrPage {
  index?: number;
  markdown?: string;
  text?: string;
  dimensions?: { dpi?: number; height?: number; width?: number };
}

interface MistralOcrResponse {
  pages?: MistralOcrPage[];
  // Mistral surfaces errors in different shapes depending on endpoint;
  // both `detail` (string|object) and `message` have been observed.
  message?: string;
  detail?: string | { message?: string };
}

async function toDataUrl(bytes: ArrayBuffer): Promise<string> {
  const blob = new Blob([bytes], { type: "image/png" });
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () =>
      reject(reader.error ?? new Error("base64 encode failed"));
    reader.readAsDataURL(blob);
  });
}

async function measurePage(bytes: ArrayBuffer): Promise<{
  width: number;
  height: number;
}> {
  const blob = new Blob([bytes], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close?.();
  return size;
}

/**
 * Turn flat markdown/text into (line,word) bbox pairs. Mistral's OCR
 * response is per-page markdown without per-word coordinates, so we
 * distribute lines evenly down the page — matching the approach used by
 * the Gemini adapter. Good enough for the invisible-text layer; future
 * layouts can swap in a detector-driven approach.
 */
function distributeLines(
  text: string,
  pageSize: { width: number; height: number },
): { words: OcrWord[]; lines: OcrLine[] } {
  const stripped = text
    .replace(/^```[a-z]*\s*\n?|\n?```$/g, "") // drop code-fence markers
    .replace(/^\s*#+\s+/gm, ""); // drop markdown headings
  const rawLines = stripped.split(/\r?\n/).map((l) => l.trim());
  const nonEmpty = rawLines.filter((l) => l.length > 0);
  if (nonEmpty.length === 0) return { words: [], lines: [] };
  const slice = pageSize.height / nonEmpty.length;
  const lines: OcrLine[] = [];
  const words: OcrWord[] = [];
  nonEmpty.forEach((lineText, i) => {
    const y = Math.round(slice * i);
    const h = Math.max(1, Math.round(slice));
    const bbox = { x: 0, y, width: pageSize.width, height: h };
    const lineWords = lineText
      .split(/\s+/)
      .filter(Boolean)
      .map<OcrWord>((w) => ({ text: w, confidence: 0.85, bbox }));
    lines.push({ text: lineText, bbox, words: lineWords });
    words.push(...lineWords);
  });
  return { words, lines };
}

function extractError(json: MistralOcrResponse, status: number): string {
  if (typeof json.detail === "string") return json.detail;
  if (json.detail && typeof json.detail === "object" && json.detail.message) {
    return json.detail.message;
  }
  if (json.message) return json.message;
  return `mistral OCR request failed (${status})`;
}

export const mistralProvider: OcrProvider = {
  id: "mistral-ocr",
  label: "Mistral OCR (hosted)",
  kind: "hosted",
  capabilities: { layout: true, tables: true, handwriting: true },
  async isAvailable() {
    if (!(await hasApiKey("mistral-ocr"))) return false;
    return (await getApiKey("mistral-ocr")) !== null;
  },
  async recognize(input: RecognizeInput): Promise<OcrResult> {
    const key = await getApiKey("mistral-ocr");
    if (!key) throw new Error("mistral-ocr API key missing or locked");
    const pageSize = await measurePage(input.pngBytes);
    const dataUrl = await toDataUrl(input.pngBytes);
    const body = {
      model: MODEL,
      document: { type: "image_url", image_url: dataUrl },
    };
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });
    const json = (await response.json()) as MistralOcrResponse;
    if (!response.ok) {
      throw new Error(extractError(json, response.status));
    }
    // Mistral returns one entry per page — we send a single page so take
    // the first. `markdown` is the canonical field; some responses only
    // expose `text`.
    const pages = json.pages ?? [];
    const first = pages[0];
    const text = first?.markdown ?? first?.text ?? "";
    const { words, lines } = distributeLines(text, pageSize);
    return {
      providerId: "mistral-ocr",
      pageSize,
      text,
      hocr: "",
      words,
      lines,
    };
  },
};
