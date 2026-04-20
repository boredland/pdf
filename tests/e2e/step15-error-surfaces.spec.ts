import { expect, test, type Page } from "@playwright/test";

async function waitForHarness(page: Page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 10_000,
  });
}

test.describe("step 15 — error-state surfaces", () => {
  test.setTimeout(60_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
    await page.evaluate(() => {
      window.__pdfApp!.testing.setDefaultOcrProvider("mock");
      window.__pdfApp!.testing.setDefaultOrientationDetect(false);
    });
  });

  test("job-progress surfaces failed stage events with a dismiss button", async ({
    page,
  }) => {
    // Create a project, load it into the UI, then emit a synthetic
    // "failed" stage event on the progress channel. The JobProgress
    // component should pick it up and render a banner.
    await page.getByTestId("load-example-synthetic").click();
    await expect(page.getByTestId("project-name")).toBeVisible();

    const projectId = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      return (await app.projects.listProjects())[0]!.id;
    });

    // The progress-channel helper is consumed internally; emit through
    // the same BroadcastChannel name so the component sees it.
    await page.evaluate((id) => {
      const ch = new BroadcastChannel("pdf-ocr-progress");
      ch.postMessage({
        kind: "stage",
        projectId: id,
        pageIndex: 0,
        stage: "ocr",
        status: "failed",
        error: "synthetic provider 503",
        ts: Date.now(),
      });
      ch.close();
    }, projectId);

    const banner = page.getByTestId("job-progress-failure-ocr-0");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/ocr/i);
    await expect(banner).toContainText("page 1");
    await expect(banner).toContainText("synthetic provider 503");

    await expect(page.getByTestId("job-progress")).toHaveAttribute(
      "data-failure-count",
      "1",
    );

    await page
      .getByTestId("job-progress-failure-dismiss-ocr-0")
      .click();
    await expect(banner).toBeHidden();
    await expect(page.getByTestId("job-progress")).toHaveAttribute(
      "data-failure-count",
      "0",
    );
  });

  test("failure banner collapses duplicates on the same stage+page", async ({
    page,
  }) => {
    await page.getByTestId("load-example-synthetic").click();
    await expect(page.getByTestId("project-name")).toBeVisible();
    const projectId = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      return (await app.projects.listProjects())[0]!.id;
    });

    // Two failures on the same (stage, pageIndex) collapse into one.
    await page.evaluate((id) => {
      const ch = new BroadcastChannel("pdf-ocr-progress");
      ch.postMessage({
        kind: "stage",
        projectId: id,
        pageIndex: 0,
        stage: "preprocess",
        status: "failed",
        error: "first try",
        ts: Date.now(),
      });
      ch.postMessage({
        kind: "stage",
        projectId: id,
        pageIndex: 0,
        stage: "preprocess",
        status: "failed",
        error: "retry also failed",
        ts: Date.now() + 10,
      });
      ch.close();
    }, projectId);

    await expect(page.getByTestId("job-progress")).toHaveAttribute(
      "data-failure-count",
      "1",
    );
    await expect(
      page.getByTestId("job-progress-failure-preprocess-0"),
    ).toContainText("retry also failed");
  });
});
