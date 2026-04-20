/// <reference lib="webworker" />
import * as Comlink from "comlink";
import type { Matrix } from "mupdf";

type Mupdf = typeof import("mupdf");

const mupdfReady: Promise<Mupdf> = import("mupdf");

export interface RenderPageInput {
  pdfBytes: ArrayBuffer;
  pageIndex: number;
  dpi: number;
}

export interface RenderPageOutput {
  pageIndex: number;
  pngBytes: ArrayBuffer;
  width: number;
  height: number;
  thumbnailDataUrl: string;
}

const THUMBNAIL_MAX_SIDE = 160;

const api = {
  async getPageCount(pdfBytes: ArrayBuffer): Promise<number> {
    const mupdf = await mupdfReady;
    const doc = mupdf.Document.openDocument(new Uint8Array(pdfBytes), "application/pdf");
    try {
      return doc.countPages();
    } finally {
      doc.destroy();
    }
  },

  async renderPage(input: RenderPageInput): Promise<RenderPageOutput> {
    const mupdf = await mupdfReady;
    const { pdfBytes, pageIndex, dpi } = input;
    const doc = mupdf.Document.openDocument(new Uint8Array(pdfBytes), "application/pdf");
    try {
      const page = doc.loadPage(pageIndex);
      const scale = dpi / 72;
      const matrix: Matrix = [scale, 0, 0, scale, 0, 0];
      const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
      try {
        const pngBytes = pixmap.asPNG();
        const width = pixmap.getWidth();
        const height = pixmap.getHeight();

        const thumbScale = Math.min(1, THUMBNAIL_MAX_SIDE / Math.max(width, height));
        const thumbMatrix: Matrix = [
          scale * thumbScale,
          0,
          0,
          scale * thumbScale,
          0,
          0,
        ];
        const thumbPixmap = page.toPixmap(
          thumbMatrix,
          mupdf.ColorSpace.DeviceRGB,
          false,
          true,
        );
        let thumbnailDataUrl: string;
        try {
          const thumbPng = thumbPixmap.asPNG();
          thumbnailDataUrl = `data:image/png;base64,${bytesToBase64(thumbPng)}`;
        } finally {
          thumbPixmap.destroy();
        }

        const transferable = toArrayBuffer(pngBytes);
        return Comlink.transfer(
          {
            pageIndex,
            pngBytes: transferable,
            width,
            height,
            thumbnailDataUrl,
          },
          [transferable],
        );
      } finally {
        pixmap.destroy();
        page.destroy();
      }
    } finally {
      doc.destroy();
    }
  },
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, Array.from(slice) as number[]);
  }
  return btoa(binary);
}

export type RenderWorkerApi = typeof api;

Comlink.expose(api);
