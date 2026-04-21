/**
 * JBIG2 encoder wrapper around the vendored jbig2enc-rust WASM build.
 *
 * Generic-region JBIG2 compresses bitonal text pages ~2-5× tighter than
 * CCITT G4. The 85 KB WASM binary is loaded once per worker lifetime.
 *
 * PDF uses `/Filter /JBIG2Decode` for the stream. Unlike CCITT, JBIG2
 * is a "self-decoding" format — the segment headers carry width/height/
 * flags internally, so the PDF XObject dict doesn't need DecodeParms.
 */

import initWasm, {
  encode_jbig2_document,
  encode_jbig2_generic,
} from "./jbig2-wasm/jbig2_wasm.js";

let ready: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (!ready) {
    // Use new URL(... import.meta.url) so both the main thread AND web
    // workers resolve the path relative to this chunk, not the HTML root.
    const url = new URL("./jbig2-wasm/jbig2_wasm_bg.wasm", import.meta.url);
    ready = initWasm(url).then(() => undefined);
  }
  return ready;
}

/**
 * Encode a bitonal image via the full JBIG2 pipeline (CC analysis →
 * symbol extraction → symbol-dict + text-region encoding). Falls back to
 * generic-region when symbol coding doesn't compress better.
 *
 * Input: 1 byte per pixel, row-major, 0=white, nonzero=black. This is
 * a different layout from the packed-bits path — the builder unpacks
 * from ImageData before calling.
 *
 * Returns the complete JBIG2 stream for `/Filter /JBIG2Decode`.
 */
export async function encodeJbig2Document(
  pixels: Uint8Array,
  widthPx: number,
  heightPx: number,
): Promise<Uint8Array> {
  await ensureInit();
  return encode_jbig2_document(pixels, widthPx, heightPx);
}

/**
 * Encode a bitonal image as a JBIG2 generic-region segment. The input is
 * 1 bit per pixel packed MSB-first, padded to byte boundaries per row
 * (same layout the builder already produces for the CCITT path).
 */
export async function encodeJbig2(
  packedBits: Uint8Array,
  widthPx: number,
  heightPx: number,
): Promise<Uint8Array> {
  await ensureInit();
  return encode_jbig2_generic(packedBits, widthPx, heightPx);
}
