/**
 * Image to PDF conversion with automatic EXIF orientation and rotation detection
 */

import { getExifOrientation, getRotationTransform } from "./exif-orientation";

/**
 * Detect rotation angle from image using edge detection (similar to deskew)
 * Returns angle in degrees to rotate image to make text horizontal
 * 
 * Note: Only detects skew/small rotations via edge detection.
 * 180° rotations without EXIF require OCR-based detection.
 */
export async function detectImageRotation(
  imageBytes: Uint8Array,
  mimeType: string,
): Promise<number> {
  try {
    // Dynamically import OpenCV
    const cv = (await import("@techstark/opencv-js")) as any;

    // Decode image
    const blob = new Blob([Buffer.from(imageBytes)], { type: mimeType });
    const img = new Image();
    await new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.src = URL.createObjectURL(blob);
    });

    // Create canvas and draw image
    const canvas = new OffscreenCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2D context");
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(img.src);

    // Get image data
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Convert to OpenCV Mat
    const src = cv.matFromImageData(imageData);
    let gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // Detect skew angle (handles ~±45° skew)
    const angle = measureSkewFromGray(cv, gray);

    // Cleanup
    gray.delete();
    src.delete();

    return angle;
  } catch (error) {
    console.warn("Rotation detection failed, skipping:", error);
    return 0;
  }
}

function measureSkewFromGray(cv: any, gray: any): number {
  const inverted = new cv.Mat();
  cv.bitwise_not(gray, inverted);
  const binary = new cv.Mat();
  cv.threshold(inverted, binary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
  const edges = new cv.Mat();
  const lines = new cv.Mat();
  try {
    cv.Canny(binary, edges, 50, 150, 3, false);
    const minLineLen = Math.max(40, Math.floor(Math.min(gray.cols, gray.rows) * 0.1));
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 80, minLineLen, 20);
    const angles: number[] = [];
    for (let i = 0; i < lines.rows; i++) {
      const base = i * 4;
      const x1 = lines.data32S[base];
      const y1 = lines.data32S[base + 1];
      const x2 = lines.data32S[base + 2];
      const y2 = lines.data32S[base + 3];
      let angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      angles.push(angle);
    }
    inverted.delete();
    binary.delete();
    edges.delete();
    lines.delete();
    if (angles.length === 0) return 0;
    angles.sort((a, b) => a - b);
    return angles[Math.floor(angles.length / 2)] ?? 0;
  } catch (e) {
    inverted.delete();
    binary.delete();
    edges.delete();
    lines.delete();
    throw e;
  }
}

export async function convertImageToPdf(
  imageBytes: Uint8Array,
  mimeType: string,
  fileName: string,
): Promise<ArrayBuffer> {
  // Dynamic import of pdf-lib to keep it bundled
  const pdflibModule = await import("pdf-lib");
  const { PDFDocument } = pdflibModule as any;

  const pdfDoc = PDFDocument.create();

  // Create image from bytes
  const imageEmbedded =
    mimeType === "image/jpeg"
      ? await pdfDoc.embedJpg(Buffer.from(imageBytes))
      : mimeType === "image/png"
        ? await pdfDoc.embedPng(Buffer.from(imageBytes))
        : null;

  if (!imageEmbedded) {
    throw new Error(`Unsupported image format: ${mimeType}`);
  }

  // Get EXIF orientation for JPEG
  let orientation = 1;
  if (mimeType === "image/jpeg") {
    orientation = getExifOrientation(imageBytes);
  }

  // If no EXIF rotation, try to detect rotation from image content
  // Note: HoughLines-based detection only catches skew/small rotations (~±45°)
  // 180° rotations without EXIF metadata will not be detected here.
  // Future: Could add OCR-based rotation detection if needed.
  let rotationAngle = 0;
  const { angle: exifAngle } = getRotationTransform(orientation);
  if (exifAngle === 0) {
    try {
      rotationAngle = await detectImageRotation(imageBytes, mimeType);
    } catch (error) {
      console.warn("Could not detect image rotation:", error);
    }
  }

  // Calculate final rotation (EXIF takes precedence)
  const totalAngle = exifAngle !== 0 ? exifAngle : rotationAngle;

  // Calculate page dimensions based on image and rotation
  let width = imageEmbedded.width;
  let height = imageEmbedded.height;
  if (totalAngle === 90 || totalAngle === 270) {
    [width, height] = [height, width];
  }

  // Create page with image dimensions
  const page = pdfDoc.addPage([width, height]);

  // Apply rotation and draw image
  if (totalAngle === 0) {
    page.drawImage(imageEmbedded, {
      x: 0,
      y: 0,
      width,
      height,
    });
  } else if (totalAngle === 90) {
    page.drawImage(imageEmbedded, {
      x: width,
      y: 0,
      width: height,
      height: width,
      rotate: imageEmbedded.width > imageEmbedded.height ? 90 : undefined,
    });
  } else if (totalAngle === 180) {
    page.drawImage(imageEmbedded, {
      x: width,
      y: height,
      width,
      height,
      rotate: 180,
    });
  } else if (totalAngle === 270) {
    page.drawImage(imageEmbedded, {
      x: 0,
      y: height,
      width: height,
      height: width,
      rotate: imageEmbedded.width > imageEmbedded.height ? 270 : undefined,
    });
  } else if (Math.abs(totalAngle) > 0.5) {
    // For small angles (skew), rotate on canvas instead
    const canvas = new OffscreenCanvas(imageEmbedded.width, imageEmbedded.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get canvas context");
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((totalAngle * Math.PI) / 180);
    ctx.translate(-canvas.width / 2, -canvas.height / 2);
    ctx.drawImage(imageEmbedded as any, 0, 0);
    const rotatedBlob = await canvas.convertToBlob({ type: "image/png" });
    const rotatedBytes = new Uint8Array(await rotatedBlob.arrayBuffer());
    const rotatedImage = await pdfDoc.embedPng(Buffer.from(rotatedBytes));
    page.drawImage(rotatedImage, {
      x: 0,
      y: 0,
      width,
      height,
    });
  }

  return await pdfDoc.save();
}

export function isImageFile(mimeType: string): boolean {
  return mimeType === "image/jpeg" || mimeType === "image/png";
}

export function isImageFileName(fileName: string): boolean {
  const ext = fileName.toLowerCase().split(".").pop();
  return ext === "jpg" || ext === "jpeg" || ext === "png";
}
