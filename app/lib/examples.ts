export const EXAMPLE_PDF_URL = `${import.meta.env.BASE_URL}examples/fallback.pdf`;
export const EXAMPLE_PDF_NAME = "Fallback example (NARA pick pending)";

export async function loadExamplePdf(): Promise<ArrayBuffer> {
  const response = await fetch(EXAMPLE_PDF_URL);
  if (!response.ok) throw new Error(`failed to load example PDF (${response.status})`);
  return response.arrayBuffer();
}
