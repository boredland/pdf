import { expect, test, type Page } from "@playwright/test";

async function waitForHarness(page: Page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 10_000,
  });
}

test.describe("scanned example fixture (OCRmyPDF skew.pdf)", () => {
  test.setTimeout(240_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
  });

  test("loadById('scanned') returns a non-trivial PDF", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = await app.example.loadById("scanned");
      return { size: bytes.byteLength, isPdf: new DataView(bytes).getUint32(0) === 0x25504446 };
    });
    expect(result.size).toBeGreaterThan(40 * 1024);
    expect(result.isPdf).toBe(true);
  });

  test("preprocess on the scanned example detects a non-trivial skew angle", async ({
    page,
  }) => {
    const outcome = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = await app.example.loadById("scanned");
      const project = await app.projects.createProjectFromBytes("scanned-skew", bytes);
      await app.render.ensurePageRows(project);
      await app.render.runRenderPipeline((await app.projects.getProject(project.id))!);
      const row = await app.db.pages.get(`${project.id}:0`);
      const blob = await app.opfs.readBlob(row!.status.render!.artifactPath);
      const renderBytes = await blob!.arrayBuffer();
      const measured = await app.preprocess.measureSkew(renderBytes);
      return { measured, renderBytes: renderBytes.byteLength };
    });

    // skew.pdf's scan is deliberately off-axis; OCRmyPDF's own tests assert
    // deskew detects > 1° on it. Our threshold is generous to account for
    // detector variance.
    expect(Math.abs(outcome.measured)).toBeGreaterThan(0.5);
    expect(outcome.renderBytes).toBeGreaterThan(100_000);
  });

  test("full pipeline produces real OCR text with more than the synthetic fixture", async ({
    page,
  }) => {
    const wordCount = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = await app.example.loadById("scanned");
      const project = await app.projects.createProjectFromBytes("scanned-full", bytes);
      await app.render.ensurePageRows(project);
      await app.pipeline.runFromStage(
        (await app.projects.getProject(project.id))!,
        "all",
      );
      const result = await app.ocr.readOcrResult(project.id, 0);
      return result?.words?.length ?? 0;
    });

    // The synthetic fixture hits ~40 words; any real scan clears that bar
    // and then some. If this drops far below we've regressed OCR quality
    // on real content.
    expect(wordCount).toBeGreaterThan(60);
  });
});
