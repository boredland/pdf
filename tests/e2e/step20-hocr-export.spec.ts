import { expect, test, type Page } from "@playwright/test";

async function waitForHarness(page: Page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 10_000,
  });
}

test.describe("step 20 — hOCR export", () => {
  test.setTimeout(180_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
    await page.evaluate(() => {
      window.__pdfApp!.testing.setDefaultOcrProvider("mock");
      window.__pdfApp!.testing.setDefaultOrientationDetect(false);
    });
  });

  test("buildHocrDocument synthesises a valid hOCR XHTML with per-page ocr_page blocks", async ({
    page,
  }) => {
    const xml = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = await app.example.load();
      const project = await app.projects.createProjectFromBytes(
        "hocr-synth",
        bytes,
      );
      await app.render.ensurePageRows(project);
      const fresh = (await app.projects.getProject(project.id))!;
      await app.pipeline.runFromStage(fresh, "all");
      const blob = await app.exportHocr(
        (await app.projects.getProject(project.id))!,
      );
      return blob ? await blob.text() : null;
    });

    expect(xml).not.toBeNull();
    // Basic shape assertions: XML prolog, hOCR meta, 3 ocr_page blocks.
    expect(xml!).toContain('<?xml version="1.0"');
    expect(xml!).toContain('name="ocr-system"');
    const pageMatches = xml!.match(/class="ocr_page"/g) ?? [];
    expect(pageMatches.length).toBe(3);
    // Every page has at least one ocr_line descendant.
    expect((xml!.match(/class="ocr_line"/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // Words carry bboxes.
    expect(xml!).toMatch(/title="bbox \d+ \d+ \d+ \d+/);
  });

  test("UI: Download hOCR button appears once any page has OCR and serves an .hocr.html blob", async ({
    page,
  }) => {
    await page.getByTestId("load-example-synthetic").click();
    await page.getByTestId("run-stage-button").click();
    // Wait for at least page 0's OCR — hOCR export only needs OCR, not build.
    await expect(page.getByTestId("page-card-0")).toHaveAttribute(
      "data-ocr-status",
      "done",
      { timeout: 180_000 },
    );
    const btn = page.getByTestId("download-hocr");
    await expect(btn).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      btn.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.hocr\.html$/);
  });

  test("buildAltoDocument synthesises conformant ALTO 4.1 XML with per-page Pages", async ({
    page,
  }) => {
    const xml = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = await app.example.load();
      const project = await app.projects.createProjectFromBytes(
        "alto-synth",
        bytes,
      );
      await app.render.ensurePageRows(project);
      const fresh = (await app.projects.getProject(project.id))!;
      await app.pipeline.runFromStage(fresh, "all");
      const blob = await app.exportAlto(
        (await app.projects.getProject(project.id))!,
      );
      return blob ? await blob.text() : null;
    });

    expect(xml).not.toBeNull();
    expect(xml!).toContain('<?xml version="1.0"');
    expect(xml!).toContain("xmlns=\"http://www.loc.gov/standards/alto/ns-v4#\"");
    expect((xml!.match(/<Page /g) ?? []).length).toBe(3);
    expect((xml!.match(/<TextLine /g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((xml!.match(/<String /g) ?? []).length).toBeGreaterThanOrEqual(3);
    // String elements carry CONTENT + WC (confidence).
    expect(xml!).toMatch(/<String[^>]*CONTENT="[^"]+" WC="[0-9.]+/);
  });

  test("UI: Download ALTO button serves an .alto.xml blob", async ({ page }) => {
    await page.getByTestId("load-example-synthetic").click();
    await page.getByTestId("run-stage-button").click();
    await expect(page.getByTestId("page-card-0")).toHaveAttribute(
      "data-ocr-status",
      "done",
      { timeout: 180_000 },
    );
    const btn = page.getByTestId("download-alto");
    await expect(btn).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      btn.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.alto\.xml$/);
  });
});
