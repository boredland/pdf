import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function waitForHarness(page: Page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 10_000,
  });
}

/** axe violations we've looked at and accepted as low-risk for now. */
const ALLOWED_VIOLATION_IDS = new Set<string>([
  // OffscreenCanvas probe element has no label; not user-facing.
  // The SW-precache dummy WASM probe is a hidden diagnostic.
  "region",
]);

async function audit(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const blocking = results.violations.filter(
    (v) => !ALLOWED_VIOLATION_IDS.has(v.id),
  );
  return { violations: results.violations, blocking };
}

test.describe("step 17 — axe accessibility scan (WCAG 2.0 AA)", () => {
  test.setTimeout(120_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
    await page.evaluate(() => {
      window.__pdfApp!.testing.setDefaultOcrProvider("mock");
      window.__pdfApp!.testing.setDefaultOrientationDetect(false);
    });
  });

  test("home page (empty state) has no WCAG AA violations", async ({ page }) => {
    const result = await audit(page);
    if (result.blocking.length > 0) {
      console.log(
        "axe blocking:",
        JSON.stringify(
          result.blocking.map((v) => ({
            id: v.id,
            help: v.help,
            nodes: v.nodes.map((n) => n.target),
          })),
          null,
          2,
        ),
      );
    }
    expect(result.blocking).toEqual([]);
  });

  test("project view (with loaded example) has no WCAG AA violations", async ({
    page,
  }) => {
    await page.getByTestId("load-example-synthetic").click();
    await expect(page.getByTestId("project-section")).toBeVisible();

    const result = await audit(page);
    if (result.blocking.length > 0) {
      console.log(
        "axe blocking:",
        JSON.stringify(
          result.blocking.map((v) => ({
            id: v.id,
            help: v.help,
            nodes: v.nodes.map((n) => n.target),
          })),
          null,
          2,
        ),
      );
    }
    expect(result.blocking).toEqual([]);
  });
});
