/**
 * EXIF orientation handler for automatic image rotation.
 * Handles the standard EXIF Orientation tag (0x0112) which specifies how an image should be displayed.
 * 
 * Orientation values:
 * 1 = Normal (no rotation)
 * 2 = Flipped horizontally
 * 3 = Rotated 180°
 * 4 = Flipped vertically
 * 5 = Rotated 90° CCW, then flipped horizontally
 * 6 = Rotated 90° CCW
 * 7 = Rotated 90° CCW, then flipped vertically
 * 8 = Rotated 90° CW
 */

export interface ImageWithOrientation {
  data: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  orientation: number;
}

/**
 * Extract EXIF orientation from JPEG bytes
 */
export function getExifOrientation(jpegBytes: Uint8Array): number {
  // JPEG starts with FFD8
  if (jpegBytes[0] !== 0xff || jpegBytes[1] !== 0xd8) {
    return 1; // Not a JPEG, default to normal
  }

  let offset = 2;
  while (offset < jpegBytes.length) {
    // Look for APP1 marker (FFE1)
    if (jpegBytes[offset] === 0xff && jpegBytes[offset + 1] === 0xe1) {
      // Found APP1 (EXIF) marker
      const length = ((jpegBytes[offset + 2] ?? 0) << 8) | (jpegBytes[offset + 3] ?? 0);
      const appData = jpegBytes.slice(offset + 4, offset + 4 + length - 2);

      // Check for EXIF header "Exif\0\0"
      if (
        appData[0] === 0x45 &&
        appData[1] === 0x78 &&
        appData[2] === 0x69 &&
        appData[3] === 0x66 &&
        appData[4] === 0x00 &&
        appData[5] === 0x00
      ) {
        return parseExifOrientation(appData.slice(6));
      }
    }
    // Skip to next marker
    offset += 2;
    if (jpegBytes[offset] === 0xff) {
      const markerLength = ((jpegBytes[offset + 1] ?? 0) << 8) | (jpegBytes[offset + 2] ?? 0);
      offset += markerLength + 2;
    }
  }

  return 1; // No EXIF data found, default to normal
}

function parseExifOrientation(exifData: Uint8Array): number {
  // TIFF header: byte order (2 bytes) + magic (2 bytes) + offset to first IFD (4 bytes)
  if (exifData.length < 8) return 1;

  const isLittleEndian = exifData[0] === 0x49 && exifData[1] === 0x49; // "II"
  const isBigEndian = exifData[0] === 0x4d && exifData[1] === 0x4d; // "MM"

  if (!isLittleEndian && !isBigEndian) return 1;

  const read16 = (offset: number): number => {
    const a = exifData[offset] ?? 0;
    const b = exifData[offset + 1] ?? 0;
    return isLittleEndian ? a | (b << 8) : (a << 8) | b;
  };

  const read32 = (offset: number): number => {
    const a = exifData[offset] ?? 0;
    const b = exifData[offset + 1] ?? 0;
    const c = exifData[offset + 2] ?? 0;
    const d = exifData[offset + 3] ?? 0;
    return isLittleEndian
      ? a | (b << 8) | (c << 16) | (d << 24)
      : (a << 24) | (b << 16) | (c << 8) | d;
  };

  // Read first IFD offset
  const firstIfdOffset = read32(4);
  if (firstIfdOffset >= exifData.length) return 1;

  // Read number of directory entries
  const numEntries = read16(firstIfdOffset);

  // Look for Orientation tag (0x0112)
  for (let i = 0; i < numEntries; i++) {
    const entryOffset = firstIfdOffset + 2 + i * 12;
    if (entryOffset + 12 > exifData.length) break;

    const tag = read16(entryOffset);
    const type = read16(entryOffset + 2);
    const count = read32(entryOffset + 4);
    const valueOffset = entryOffset + 8;

    // Orientation tag is 0x0112, type is SHORT (3), count is 1
    if (tag === 0x0112 && type === 3 && count === 1) {
      const orientation = read16(valueOffset);
      return Math.min(Math.max(orientation, 1), 8);
    }
  }

  return 1;
}

/**
 * Apply EXIF orientation to an image canvas
 * Returns rotation angle in degrees (0, 90, 180, 270) and whether to flip
 */
export function getRotationTransform(
  orientation: number,
): { angle: number; flipX: boolean; flipY: boolean } {
  const transforms: Record<
    number,
    { angle: number; flipX: boolean; flipY: boolean }
  > = {
    1: { angle: 0, flipX: false, flipY: false },
    2: { angle: 0, flipX: true, flipY: false },
    3: { angle: 180, flipX: false, flipY: false },
    4: { angle: 0, flipX: false, flipY: true },
    5: { angle: 90, flipX: true, flipY: false },
    6: { angle: 90, flipX: false, flipY: false },
    7: { angle: 270, flipX: true, flipY: false },
    8: { angle: 270, flipX: false, flipY: false },
  };
  return transforms[orientation] || { angle: 0, flipX: false, flipY: false };
}

/**
 * Draw an image on canvas with automatic EXIF orientation applied
 */
export async function drawImageWithOrientation(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  imageOrUrl: HTMLImageElement | string,
  x: number,
  y: number,
  width: number,
  height: number,
  orientation: number,
): Promise<void> {
  const img = typeof imageOrUrl === 'string' ? new Image() : imageOrUrl;

  if (typeof imageOrUrl === 'string') {
    await new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.src = imageOrUrl;
    });
  }

  const { angle, flipX, flipY } = getRotationTransform(orientation);

  ctx.save();
  ctx.translate(x + width / 2, y + height / 2);
  ctx.rotate((angle * Math.PI) / 180);
  if (flipX) ctx.scale(-1, 1);
  if (flipY) ctx.scale(1, -1);
  ctx.drawImage(img, -width / 2, -height / 2, width, height);
  ctx.restore();
}
