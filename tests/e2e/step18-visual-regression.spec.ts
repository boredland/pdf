import { expect, test, type Page } from "@playwright/test";

async function waitForHarness(page: Page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 10_000,
  });
}

// Visual regression is a broad brush by design. We're not trying to pin
// every pixel — Playwright's default maxDiffPixelRatio (0) is too strict
// for Chromium font rasterization drift. A small pixel budget catches real
// regressions (moved buttons, colour swaps, missing panels) while letting
// through sub-pixel anti-aliasing noise.
const SNAP_OPTIONS = {
  maxDiffPixelRatio: 0.015,
  animations: "disabled" as const,
};

test.describe("step 18 — visual regression", () => {
  test.setTimeout(180_000);
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await waitForHarness(page);
    await page.evaluate(() => {
      window.__pdfApp!.testing.setDefaultOcrProvider("mock");
      window.__pdfApp!.testing.setDefaultOrientationDetect(false);
    });
  });

  test("home — empty state", async ({ page }) => {
    await expect(page.getByTestId("home-heading")).toBeVisible();
    // Hide the live assets pill — its cached-entry count drifts between
    // runs depending on whether the SW finished precaching.
    await page.addStyleTag({
      content: `[data-testid="assets-pill"] { visibility: hidden; }`,
    });
    await expect(page).toHaveScreenshot("home-empty.png", SNAP_OPTIONS);
  });

  test("project — loaded (pre-run)", async ({ page }) => {
    await page.getByTestId("load-example-synthetic").click();
    await expect(page.getByTestId("project-section")).toBeVisible();
    await page.addStyleTag({
      content: `[data-testid="assets-pill"] { visibility: hidden; }
                [data-testid="project-meta"] { visibility: hidden; }`,
    });
    await expect(page).toHaveScreenshot("project-loaded.png", SNAP_OPTIONS);
  });

  test("project — built (post-run)", async ({ page }) => {
    await page.getByTestId("load-example-synthetic").click();
    await page.getByTestId("run-stage-button").click();
    await expect(page.getByTestId("download-pdf")).toBeVisible({
      timeout: 120_000,
    });
    await page.addStyleTag({
      content: `[data-testid="assets-pill"] { visibility: hidden; }
                [data-testid="project-meta"] { visibility: hidden; }
                [data-testid="project-size-delta"] { visibility: hidden; }
                img { visibility: hidden; }`,
    });
    await expect(page).toHaveScreenshot("project-built.png", SNAP_OPTIONS);
  });
});
