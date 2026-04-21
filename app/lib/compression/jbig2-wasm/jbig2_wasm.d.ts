/* tslint:disable */
/* eslint-disable */

/**
 * Encode a bitonal image as a JBIG2 stream using the full encoder pipeline
 * (CC analysis → symbol extraction → symbol-dict encoding). This is the
 * "real" JBIG2 path that produces DjVu-class output via symbol coding.
 *
 * Input: 1 byte per pixel, row-major, 0=white, 255=black (or any nonzero).
 * Returns the complete JBIG2 stream suitable for `/Filter /JBIG2Decode`.
 */
export function encode_jbig2_document(pixels: Uint8Array, width: number, height: number): Uint8Array;

/**
 * Encode a bitonal image as a JBIG2 generic-region segment (no symbol coding).
 * Faster but ~2× larger than the full pipeline.
 *
 * Input: MSB-first bit-packed, rows padded to byte boundaries.
 */
export function encode_jbig2_generic(packed_bits: Uint8Array, width: number, height: number): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly encode_jbig2_document: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly encode_jbig2_generic: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
