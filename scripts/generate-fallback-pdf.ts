/**
 * Generates a small, deterministic fallback example PDF that ships with the
 * repo. In production the deploy workflow overwrites it with the smallest PDF
 * from NARA record 12044361 (see scripts/resolve-example-pdf.ts, arriving in
 * step 10). Until then — and for tests — this committed artifact is the source
 * of truth.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const PAGES = 3;
const OUT = "public/examples/fallback.pdf";

async function main() {
  const doc = await PDFDocument.create();
  doc.setTitle("pdf fallback example");
  doc.setAuthor("boredland/pdf");
  doc.setCreationDate(new Date("2026-01-01T00:00:00Z"));
  doc.setModificationDate(new Date("2026-01-01T00:00:00Z"));

  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let i = 0; i < PAGES; i++) {
    const page = doc.addPage([612, 792]);
    const heading = `Page ${i + 1}`;
    const body = [
      "This is the bundled fallback example PDF used by the app during",
      "development and by the Playwright test suite. Production builds",
      "overlay this file with the smallest PDF from NARA record 12044361",
      "via scripts/resolve-example-pdf.ts.",
      "",
      `Synthetic page ${i + 1} of ${PAGES}.`,
    ];

    page.drawText(heading, {
      x: 72,
      y: 720,
      size: 32,
      font,
      color: rgb(0.1, 0.1, 0.15),
    });
    body.forEach((line, idx) => {
      page.drawText(line, {
        x: 72,
        y: 660 - idx * 24,
        size: 14,
        font,
        color: rgb(0.2, 0.2, 0.25),
      });
    });
  }

  const bytes = await doc.save();
  await mkdir("public/examples", { recursive: true });
  await writeFile(OUT, bytes);
  console.log(`wrote ${OUT} (${bytes.length} bytes, ${PAGES} pages)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
