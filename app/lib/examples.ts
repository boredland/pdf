export const EXAMPLE_PDFS = {
  scanned: {
    id: "scanned",
    url: `${import.meta.env.BASE_URL}examples/scanned.pdf`,
    name: "OCRmyPDF skew.pdf (scanned, deliberately skewed)",
    description:
      "Real scanned document with skew and scan noise. Exercises the full preprocess pipeline.",
  },
  cardinal: {
    id: "cardinal",
    url: `${import.meta.env.BASE_URL}examples/cardinal.pdf`,
    name: "OCRmyPDF cardinal.pdf (mixed content)",
    description:
      "Multi-page scanned document with text and image content. Good for testing MRC compression.",
  },
  synthetic: {
    id: "synthetic",
    url: `${import.meta.env.BASE_URL}examples/fallback.pdf`,
    name: "Synthetic 3-page fallback",
    description:
      "Trivial born-digital PDF with deterministic text — used by the OCR-correctness tests.",
  },
} as const;

export type ExampleId = keyof typeof EXAMPLE_PDFS;

// Default: the real scan. Tests that need deterministic text pass "synthetic".
export const DEFAULT_EXAMPLE_ID: ExampleId = "scanned";

export async function loadExamplePdf(id: ExampleId = DEFAULT_EXAMPLE_ID): Promise<ArrayBuffer> {
  const target = EXAMPLE_PDFS[id];
  const response = await fetch(target.url);
  if (!response.ok) {
    // Graceful fallback: the scanned PDF is fetched at postinstall and could
    // be missing in a very fresh checkout before `bun install` completes.
    if (id === "scanned") {
      console.warn(
        `scanned example not available (${response.status}) — falling back to synthetic`,
      );
      return loadExamplePdf("synthetic");
    }
    throw new Error(`failed to load example PDF (${response.status})`);
  }
  return response.arrayBuffer();
}

// Back-compat: older test harness fields expected single-URL strings.
export const EXAMPLE_PDF_URL = EXAMPLE_PDFS.scanned.url;
export const EXAMPLE_PDF_NAME = EXAMPLE_PDFS.scanned.name;
