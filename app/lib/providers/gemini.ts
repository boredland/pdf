import { getApiKey, hasApiKey } from "~/lib/api-keys";
import type {
  OcrLine,
  OcrProvider,
  OcrResult,
  OcrWord,
  RecognizeInput,
} from "./types";

const MODEL = "gemini-2.5-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const PROMPT = `You are an OCR engine. Extract the visible text from the page image.
- Preserve line breaks exactly as they appear in the image.
- Do not add commentary, prefixes, headers, or markdown.
- If the page has no legible text, return an empty response.
Return only the plain text.`;

interface GeminiResponsePart {
  text?: string;
}
interface GeminiResponseCandidate {
  content?: { parts?: GeminiResponsePart[] };
}
interface GeminiResponse {
  candidates?: GeminiResponseCandidate[];
  error?: { message?: string };
}

async function toBase64(bytes: ArrayBuffer): Promise<string> {
  const blob = new Blob([bytes]);
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const comma = dataUrl.indexOf(",");
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    reader.onerror = () => reject(reader.error ?? new Error("base64 encode failed"));
    reader.readAsDataURL(blob);
  });
}

async function measurePage(bytes: ArrayBuffer): Promise<{ width: number; height: number }> {
  const blob = new Blob([bytes], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close?.();
  return size;
}

function splitLines(
  text: string,
  pageSize: { width: number; height: number },
): { words: OcrWord[]; lines: OcrLine[] } {
  // Hosted providers return flat text without per-word bboxes. We synthesise
  // line-level bboxes evenly down the page so downstream stages (builder,
  // exports) have *something* to work with. Real coordinates will arrive in
  // step 8 when we layer OCR output per detected text region instead of
  // per-page.
  const rawLines = text.split(/\r?\n/).map((l) => l.trim());
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
      .map<OcrWord>((w) => ({
        text: w,
        confidence: 0.85,
        bbox,
      }));
    lines.push({ text: lineText, bbox, words: lineWords });
    words.push(...lineWords);
  });
  return { words, lines };
}

export const geminiProvider: OcrProvider = {
  id: "gemini-flash",
  label: "Gemini 2.5 Flash (hosted)",
  kind: "hosted",
  capabilities: { layout: true, tables: true, handwriting: true },
  async isAvailable() {
    if (!(await hasApiKey("gemini-flash"))) return false;
    return (await getApiKey("gemini-flash")) !== null;
  },
  async recognize(input: RecognizeInput): Promise<OcrResult> {
    const key = await getApiKey("gemini-flash");
    if (!key) throw new Error("gemini-flash API key missing or locked");
    const pageSize = await measurePage(input.pngBytes);
    const base64 = await toBase64(input.pngBytes);
    const url = `${ENDPOINT}?key=${encodeURIComponent(key)}`;
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: PROMPT },
            { inlineData: { mimeType: "image/png", data: base64 } },
          ],
        },
      ],
      generationConfig: { temperature: 0, responseMimeType: "text/plain" },
    };
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: input.signal,
    });
    const json = (await response.json()) as GeminiResponse;
    if (!response.ok) {
      throw new Error(json.error?.message ?? `gemini request failed (${response.status})`);
    }
    const text = (json.candidates ?? [])
      .flatMap((c) => c.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");
    const { words, lines } = splitLines(text, pageSize);
    return {
      providerId: "gemini-flash",
      pageSize,
      text,
      hocr: "",
      words,
      lines,
    };
  },
};
