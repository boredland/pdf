/**
 * Reduce PNG mask to pure black and white so PNG's zlib compression has
 * long runs to work with. Typical improvement: 50-70% file size reduction
 * on mostly-binary masks.
 *
 * Runs inside the MRC worker, so we only use worker-safe APIs
 * (createImageBitmap + OffscreenCanvas).
 */
export async function optimizeMaskPng(pngBytes: Uint8Array): Promise<Uint8Array> {
  const blob = new Blob([pngBytes.slice().buffer], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d ctx unavailable");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i + 3]! === 0 ? 255 : data[i]! < 128 ? 0 : 255;
    data[i] = gray;
    data[i + 1] = gray;
    data[i + 2] = gray;
    data[i + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  const out = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await out.arrayBuffer());
}
