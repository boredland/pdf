import type { OcrProvider, OcrResult, RecognizeInput } from "./types";

function pngSize(bytes: ArrayBuffer): { width: number; height: number } {
  const view = new DataView(bytes);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export const mockProvider: OcrProvider = {
  id: "mock",
  label: "Mock (test-only, instant)",
  kind: "local",
  capabilities: { layout: true, tables: false, handwriting: false },
  async isAvailable() {
    return true;
  },
  async recognize(input: RecognizeInput): Promise<OcrResult> {
    const { width, height } = pngSize(input.pngBytes);
    const text = `Mock page ${input.pageIndex + 1} of example document.`;
    const tokens = text.split(" ");
    const words = tokens.map((w, i) => ({
      text: w,
      confidence: 0.99,
      bbox: {
        x: 20 + i * 90,
        y: 40,
        width: 80,
        height: 28,
      },
    }));
    return {
      providerId: "mock",
      pageSize: { width, height },
      text,
      hocr: `<div class="ocr_page">${text}</div>`,
      words,
      lines: [
        {
          text,
          bbox: { x: 20, y: 40, width: 90 * tokens.length, height: 28 },
          words,
        },
      ],
    };
  },
};
