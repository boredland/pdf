# pdf

Client-side OCR webapp for PDFs. Fully in the browser: WASM for PDF parsing, image processing and compression; web workers for parallelism; OPFS + IndexedDB for persistence.

Live: https://boredland.github.io/pdf/

## Why

- **No server.** Your documents stay on your device. Hosted OCR providers are called directly from your browser with keys you supply.
- **WASM-heavy.** mupdf, OpenCV, Tesseract, jbig2enc, openjpeg all run as compiled native code.
- **Parallel.** Pages process concurrently across a worker pool sized to your hardware.
- **Resumable.** Close the tab mid-job, come back later, pick up where you left off.
- **Small outputs.** MRC-compressed PDFs (JBIG2 masks + JPEG 2000 backgrounds) reach DjVu-class file sizes in a format every viewer opens natively.

## Developing

```sh
bun install
bun run dev
bun run test:e2e
```

## Deployment

GitHub Actions builds and deploys to GitHub Pages on every push to `main`. See `.github/workflows/deploy.yml`.

The `NARA_API_KEY` repo secret is required for the example-PDF resolver to pick the smallest PDF from [NARA record 12044361](https://catalog.archives.gov/id/12044361). If absent, the committed fallback is shipped.

## Plan

Implementation is staged, with a Playwright gate at every step. See the plan file for details.
