/**
 * Copies Tesseract.js core + worker artifacts into public/tesseract/ and
 * downloads the English traineddata so we can serve everything from our own
 * origin. Keeps OCR offline-capable after first load (thanks to the SW) and
 * avoids the jsdelivr hop on every cold start.
 *
 * Runs as a postinstall hook. Safe to re-run; short-circuits when every
 * expected file is present.
 */
import { createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const OUT = "public/tesseract";
const CORE_PKG = "node_modules/tesseract.js-core";
const JS_DIST = "node_modules/tesseract.js/dist";
// Tessdata 4.1.0 from the upstream tessdata_fast repo (served raw via
// jsdelivr). Tesseract 5 uses this same format version.
const TRAINEDDATA_URL =
  "https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@4.1.0/eng.traineddata";
const TRAINEDDATA_OUT = `${OUT}/eng.traineddata`;
const OSD_URL =
  "https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@4.1.0/osd.traineddata";
const OSD_OUT = `${OUT}/osd.traineddata`;

// Real scanned fixture: OCRmyPDF's deliberately-skewed test PDF (MPL-2.0).
// Pinned by commit so the file never drifts under us.
const EXAMPLES_DIR = "public/examples";
const SCANNED_EXAMPLE = {
  url: "https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/v16.11.0/tests/resources/skew.pdf",
  out: `${EXAMPLES_DIR}/scanned.pdf`,
  minBytes: 50_000,
};

// Mixed content example: OCRmyPDF's cardinal.pdf with images (MPL-2.0).
// Good for testing MRC with non-trivial page content.
const CARDINAL_EXAMPLE = {
  url: "https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/v16.11.0/tests/resources/cardinal.pdf",
  out: `${EXAMPLES_DIR}/cardinal.pdf`,
  minBytes: 50_000,
};

const CORE_FILES = [
  "tesseract-core.wasm",
  "tesseract-core.wasm.js",
  "tesseract-core-lstm.wasm",
  "tesseract-core-lstm.wasm.js",
  "tesseract-core-simd.wasm",
  "tesseract-core-simd.wasm.js",
  "tesseract-core-simd-lstm.wasm",
  "tesseract-core-simd-lstm.wasm.js",
  "tesseract-core-relaxedsimd.wasm",
  "tesseract-core-relaxedsimd.wasm.js",
  "tesseract-core-relaxedsimd-lstm.wasm",
  "tesseract-core-relaxedsimd-lstm.wasm.js",
];

const JS_FILES = ["worker.min.js"];

async function fileHasSize(path: string, minBytes: number): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile() && s.size >= minBytes;
  } catch {
    return false;
  }
}

async function copyIfMissing(src: string, dst: string) {
  if (existsSync(dst)) return;
  if (!existsSync(src)) throw new Error(`missing source: ${src}`);
  await cp(src, dst);
  console.log(`copied ${src} -> ${dst}`);
}

async function downloadFile(url: string, out: string, minBytes: number) {
  if (await fileHasSize(out, minBytes)) return;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`fetch failed ${res.status} ${res.statusText}`);
  }
  const needGunzip = url.endsWith(".gz");
  const stages = needGunzip
    ? [Readable.fromWeb(res.body as never), createGunzip(), createWriteStream(out)]
    : [Readable.fromWeb(res.body as never), createWriteStream(out)];
  // pipeline is variadic; assert it accepts the stage list.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (pipeline as any)(...stages);
  console.log(`wrote ${out}`);
}

async function downloadTraineddata() {
  await downloadFile(TRAINEDDATA_URL, TRAINEDDATA_OUT, 2 * 1024 * 1024);
}

async function downloadOsdTraineddata() {
  await downloadFile(OSD_URL, OSD_OUT, 5 * 1024);
}

async function downloadScannedExample() {
  if (await fileHasSize(SCANNED_EXAMPLE.out, SCANNED_EXAMPLE.minBytes)) return;
  await mkdir(EXAMPLES_DIR, { recursive: true });
  console.log(`downloading ${SCANNED_EXAMPLE.url}`);
  const res = await fetch(SCANNED_EXAMPLE.url);
  if (!res.ok || !res.body) {
    throw new Error(`fetch failed ${res.status} ${res.statusText}`);
  }
  await pipeline(
    Readable.fromWeb(res.body as never),
    createWriteStream(SCANNED_EXAMPLE.out),
  );
  console.log(`wrote ${SCANNED_EXAMPLE.out}`);
}

async function downloadCardinalExample() {
  if (await fileHasSize(CARDINAL_EXAMPLE.out, CARDINAL_EXAMPLE.minBytes)) return;
  await mkdir(EXAMPLES_DIR, { recursive: true });
  console.log(`downloading ${CARDINAL_EXAMPLE.url}`);
  const res = await fetch(CARDINAL_EXAMPLE.url);
  if (!res.ok || !res.body) {
    throw new Error(`fetch failed ${res.status} ${res.statusText}`);
  }
  await pipeline(
    Readable.fromWeb(res.body as never),
    createWriteStream(CARDINAL_EXAMPLE.out),
  );
  console.log(`wrote ${CARDINAL_EXAMPLE.out}`);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  if (!existsSync(CORE_PKG) || !existsSync(JS_DIST)) {
    console.warn(
      "Tesseract packages missing from node_modules — skipping asset copy",
    );
    return;
  }

  for (const name of CORE_FILES) {
    await copyIfMissing(`${CORE_PKG}/${name}`, `${OUT}/${name}`);
  }
  for (const name of JS_FILES) {
    await copyIfMissing(`${JS_DIST}/${name}`, `${OUT}/${name}`);
  }

  try {
    await downloadTraineddata();
  } catch (err) {
    console.warn(
      `failed to download eng.traineddata: ${(err as Error).message}.\n` +
        "OCR will still work — tesseract.js will fall back to jsdelivr on first use.",
    );
  }

  try {
    await downloadOsdTraineddata();
  } catch (err) {
    console.warn(
      `failed to download osd.traineddata: ${(err as Error).message}.\n` +
        "Orientation detection will be skipped at runtime.",
    );
  }

  try {
    await downloadScannedExample();
  } catch (err) {
    console.warn(
      `failed to download scanned example: ${(err as Error).message}.\n` +
        "Synthetic fallback will still be available.",
    );
  }

  try {
    await downloadCardinalExample();
  } catch (err) {
    console.warn(
      `failed to download cardinal example: ${(err as Error).message}.\n` +
        "Scanned example will still be available.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
