import { expect, test, type Page } from "@playwright/test";

async function waitForHarness(page: Page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 10_000,
  });
}

async function bootstrapFull(page: Page) {
  await page.getByTestId("load-example-synthetic").click();
    await page.getByTestId("run-stage-button").click();
  await expect(page.getByTestId("page-card-0")).toHaveAttribute(
    "data-ocr-status",
    "done",
    { timeout: 120_000 },
  );
}

test.describe("step 7.7 — per-stage thumbs + image modal", () => {
  test.setTimeout(180_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
    await page.evaluate(() => {
      window.__pdfApp!.testing.setDefaultOcrProvider("mock");
      window.__pdfApp!.testing.setDefaultOrientationDetect(false);
    });
  });

  test("stage strip is hidden by default, expands via <details>", async ({ page }) => {
    await bootstrapFull(page);
    await expect(page.getByTestId("stage-strip-0")).not.toBeVisible();
    await page.getByTestId("page-details-summary-0").click();
    await expect(page.getByTestId("stage-strip-0")).toBeVisible();

    // Stages in the critical path (render→preprocess→detect→ocr) are
    // enabled after the UI "Run". Stages in the critical path:
    // its thumb may be disabled or pending.
    for (const stage of ["render", "preprocess", "detect", "ocr"]) {
      const thumb = page.getByTestId(`stage-thumb-0-${stage}`);
      await expect(thumb).toBeVisible();
      await expect(thumb).not.toBeDisabled();
    }
  });

  test("clicking a stage thumb opens a modal with the full-size image", async ({
    page,
  }) => {
    await bootstrapFull(page);
    await page.getByTestId("page-details-summary-0").click();

    for (const stage of ["render", "preprocess", "detect"]) {
      await page.getByTestId(`stage-thumb-0-${stage}`).click();
      const modal = page.getByTestId("image-modal");
      await expect(modal).toBeVisible();
      await expect(page.getByTestId("image-modal-image")).toBeVisible();
      await page.getByTestId("image-modal-close").click();
      await expect(modal).toBeHidden();
    }
  });

  test("OCR thumb opens a modal with extracted text body", async ({ page }) => {
    await bootstrapFull(page);
    await page.getByTestId("page-details-summary-0").click();
    await page.getByTestId("stage-thumb-0-ocr").click();
    await expect(page.getByTestId("image-modal")).toBeVisible();
    await expect(page.getByTestId("image-modal-ocr-text")).toContainText(/Page|page/);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("image-modal")).toBeHidden();
  });

  test("detect overlay artifact is persisted to OPFS with matching hash", async ({
    page,
  }) => {
    await bootstrapFull(page);
    const paths = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const projects = await app.projects.listProjects();
      const project = projects[0]!;
      const row = await app.db.pages.get(`${project.id}:0`);
      const overlayPath = row?.status.detect?.overlayPath;
      if (!overlayPath) return null;
      const blob = await app.opfs.readBlob(overlayPath);
      return {
        overlayPath,
        sizeBytes: blob?.size ?? 0,
      };
    });
    expect(paths).not.toBeNull();
    expect(paths!.overlayPath).toContain("detect-overlay.");
    expect(paths!.sizeBytes).toBeGreaterThan(10_000);
  });

  test("thumb for an unready stage is disabled", async ({ page }) => {
    // Bootstrap a project but only run render + preprocess.
    const projectId = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = await app.example.load();
      const project = await app.projects.createProjectFromBytes("partial", bytes);
      await app.render.ensurePageRows(project);
      await app.pipeline.runStage(
        (await app.projects.getProject(project.id))!,
        "render",
      );
      await app.pipeline.runStage(
        (await app.projects.getProject(project.id))!,
        "preprocess",
      );
      return project.id;
    });

    // Load the example UI with the already-created project selected by reloading.
    // Simpler: just check via DOM that thumbs for render+preprocess are enabled,
    // others disabled. We need a project loaded in the UI — the UI shows the
    // last active project after ingest, not an arbitrary one. So use the
    // load-example path but then rewind to create partial state.
    await page.getByTestId("load-example-synthetic").click();
    await page.getByTestId("run-stage-button").click();
    await expect(page.getByTestId("page-card-0")).toHaveAttribute(
      "data-render-status",
      "done",
      { timeout: 60_000 },
    );
    await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const projects = await app.projects.listProjects();
      const current = projects.find((p) => p.name.includes("Synthetic"));
      if (!current) return;
      await app.rewind.toStage(current.id, "detect");
    }, projectId);

    await page.getByTestId("page-details-summary-0").click();
    // After rewinding to detect, detect/ocr should be pending again.
    await expect(page.getByTestId("stage-thumb-0-detect")).toBeDisabled({
      timeout: 10_000,
    });
  });
});
