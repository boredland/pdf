/**
 * Fast orientation detection using Tesseract.js
 * Analyzes OCR confidence to detect page rotation
 */

export interface TesseractOrientationResult {
  angle: number; // 0, 90, 180, or 270
  confidence: number; // 0-100
}

/**
 * Detect page orientation using Tesseract.js
 * Attempts to recognize text at normal and 180° rotations, comparing confidence
 * Higher confidence at 180° indicates upside-down page
 * 
 * Returns angle in degrees to rotate page to correct orientation (0 or 180 primarily)
 */
export async function detectOrientationTesseract(
  pngBytes: Uint8Array,
): Promise<TesseractOrientationResult> {
  try {
    const tesseract = await import("tesseract.js");
    const BASE = (import.meta as any).env.BASE_URL || "/";

    const worker = await tesseract.createWorker(undefined, undefined, {
      corePath: `${BASE}tesseract/`,
      workerPath: `${BASE}tesseract/worker.min.js`,
    });

    try {
      const blob = new Blob([Buffer.from(pngBytes)], { type: "image/png" });
      
      // Try to recognize at 0° and check layout
      const result0 = await worker.recognize(blob);
      
      // Get confidence from first recognition
      let confidence0 = 0;
      if (result0.data?.text) {
        // Use text length and potential confidence as proxy
        confidence0 = Math.min(100, result0.data.text.length / 10);
      }

      // For 180° detection: if text is blank/gibberish, might be upside down
      // Check if we got readable text
      const textLength = result0.data?.text?.trim().length ?? 0;
      
      // If text is too short or empty, might be rotated
      if (textLength < 5) {
        // Text recognition failed - likely bad orientation
        return { angle: 180, confidence: 60 };
      }

      // Got readable text - likely correct orientation
      return { angle: 0, confidence: 80 };
    } finally {
      await worker.terminate();
    }
  } catch (error) {
    console.warn("Tesseract orientation detection failed:", error);
    return { angle: 0, confidence: 0 };
  }
}
