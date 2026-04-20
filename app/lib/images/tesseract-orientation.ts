/**
 * Fast orientation detection using Tesseract.js OSD
 * OSD = Orientation and Script Detection (built-in Tesseract feature)
 */

export interface TesseractOrientationResult {
  angle: number; // 0, 90, 180, or 270
  confidence: number; // 0-100
}

/**
 * Detect page orientation using Tesseract.js OSD (Orientation and Script Detection)
 * Built-in Tesseract method specifically for detecting page rotation
 * Much faster than full OCR recognition
 * 
 * Returns angle in degrees (0, 90, 180, 270) detected as needing rotation
 */
export async function detectOrientationTesseract(
  pngBytes: Uint8Array,
): Promise<TesseractOrientationResult> {
  try {
    const tesseract = await import("tesseract.js");
    const BASE = (import.meta as any).env.BASE_URL || "/";

    const blob = new Blob([Buffer.from(pngBytes)], { type: "image/png" });
    
    // Use Tesseract.js's built-in OSD (Orientation and Script Detection)
    // This is faster and more reliable than trying to infer from text recognition
    const result = await tesseract.detect(blob, {
      corePath: `${BASE}tesseract/`,
      workerPath: `${BASE}tesseract/worker.min.js`,
    });

    // OSD returns: angle (0, 90, 180, 270) and confidence
    const angle = result.data?.angle ?? 0;
    const confidence = result.data?.confidence ?? 0;

    return { 
      angle: Math.round(angle) as 0 | 90 | 180 | 270,
      confidence: Math.round(confidence * 100) // Convert to 0-100 scale
    };
  } catch (error) {
    console.warn("Tesseract OSD orientation detection failed:", error);
    return { angle: 0, confidence: 0 };
  }
}
