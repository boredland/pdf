import { expect, test, type Page } from "@playwright/test";

async function waitForHarness(page: Page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 10_000,
  });
}

test.describe("step 21 — batch import + project switcher", () => {
  test.setTimeout(60_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
    await page.evaluate(() => {
      window.__pdfApp!.testing.setDefaultOcrProvider("mock");
      window.__pdfApp!.testing.setDefaultOrientationDetect(false);
    });
  });

  test("file-input accepts multiple PDFs → creates one project per file", async ({
    page,
  }) => {
    const pdfBytes = await page.evaluate(async () => {
      const res = await fetch("/examples/fallback.pdf");
      return Array.from(new Uint8Array(await res.arrayBuffer()));
    });
    const payload = Buffer.from(pdfBytes);

    await page.getByTestId("file-input").setInputFiles([
      { name: "alpha.pdf", mimeType: "application/pdf", buffer: payload },
      { name: "beta.pdf", mimeType: "application/pdf", buffer: payload },
      { name: "gamma.pdf", mimeType: "application/pdf", buffer: payload },
    ]);

    // The most recently ingested project becomes active.
    await expect(page.getByTestId("project-name")).toHaveText("gamma.pdf", {
      timeout: 20_000,
    });

    // Project switcher appears as soon as >=2 projects exist.
    const switcher = page.getByTestId("project-switcher");
    await expect(switcher).toBeVisible();
    await expect(switcher.locator("option")).toHaveCount(3);

    // Picking a different project updates the active view.
    // Pick the alpha.pdf option by matching its visible label.
    const alphaValue = await switcher
      .locator("option", { hasText: "alpha.pdf" })
      .first()
      .getAttribute("value");
    await switcher.selectOption(alphaValue!);
    await expect(page.getByTestId("project-name")).toHaveText("alpha.pdf");
  });

  test("switcher hidden when only a single project exists", async ({ page }) => {
    await page.getByTestId("load-example-synthetic").click();
    await expect(page.getByTestId("project-name")).toHaveText(/Synthetic/, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("project-switcher-wrap")).toBeHidden();
  });
});
