/**
 * Convert a JPEG/PNG upload into a single-page PDF.
 *
 * Modern browsers (Chromium ≥99, Safari ≥13.1, Firefox ≥77) honour the EXIF
 * Orientation tag automatically when decoding via `createImageBitmap`. We lean
 * on that: decode → redraw at the oriented size → encode as PNG → embed.
 * The resulting PDF page always reads "right-side up" regardless of viewer.
 *
 * Rotation detection WITHOUT EXIF (OSD/HoughLines) is not yet wired up.
 */

import { PDFDocument } from "pdf-lib";

export async function convertImageToPdf(
  imageBytes: Uint8Array,
  mimeType: string,
  _fileName: string,
): Promise<ArrayBuffer> {
  if (mimeType !== "image/jpeg" && mimeType !== "image/png") {
    throw new Error(`Unsupported image format: ${mimeType}`);
  }

  // Decode with explicit EXIF-aware orientation. Chromium defaults to this
  // behaviour since ~M99; pinning it here guards against surface changes.
  const blob = new Blob([imageBytes.slice().buffer], { type: mimeType });
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const width = bitmap.width;
  const height = bitmap.height;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const pngBlob = await canvas.convertToBlob({ type: "image/png" });
  const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());

  const pdfDoc = await PDFDocument.create();
  const embedded = await pdfDoc.embedPng(pngBytes);
  const page = pdfDoc.addPage([embedded.width, embedded.height]);
  page.drawImage(embedded, {
    x: 0,
    y: 0,
    width: embedded.width,
    height: embedded.height,
  });

  const saved = await pdfDoc.save();
  const copy = new ArrayBuffer(saved.byteLength);
  new Uint8Array(copy).set(saved);
  return copy;
}

export function isImageFile(mimeType: string): boolean {
  return mimeType === "image/jpeg" || mimeType === "image/png";
}

export function isImageFileName(fileName: string): boolean {
  const ext = fileName.toLowerCase().split(".").pop();
  return ext === "jpg" || ext === "jpeg" || ext === "png";
}
