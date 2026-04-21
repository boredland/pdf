import { expect, test, type Page } from "@playwright/test";

async function waitForHarness(page: Page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 10_000,
  });
}

test.describe("step 14 — page removal", () => {
  test.setTimeout(120_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
    await page.evaluate(() => {
      window.__pdfApp!.testing.setDefaultOcrProvider("mock");
      window.__pdfApp!.testing.setDefaultOrientationDetect(false);
    });
  });

  test("removePage wipes artifacts, decrements pageCount, invalidates build", async ({
    page,
  }) => {
    const outcome = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = await app.example.load();
      const project = await app.projects.createProjectFromBytes(
        "page-remove-harness",
        bytes,
      );
      await app.render.ensurePageRows(project);
      await app.pipeline.runFromStage(
        (await app.projects.getProject(project.id))!,
        "all",
      );
      const beforeProject = (await app.projects.getProject(project.id))!;
      const beforePages = await app.db.pages
        .where({ projectId: project.id })
        .toArray();
      const removedPage = beforePages.find((p) => p.index === 1)!;
      const probePath = removedPage.status.ocr?.artifactPath ?? null;
      const probeExistsBefore = probePath
        ? !!(await app.opfs.readBlob(probePath))
        : false;

      await app.projects.removePage(project.id, 1);

      const afterProject = (await app.projects.getProject(project.id))!;
      const afterPages = await app.db.pages
        .where({ projectId: project.id })
        .toArray();
      const probeExistsAfter = probePath
        ? !!(await app.opfs.readBlob(probePath))
        : true;

      return {
        beforeCount: beforeProject.pageCount,
        afterCount: afterProject.pageCount,
        beforeBuildExists: !!beforeProject.build,
        afterBuildExists: !!afterProject.build,
        remainingIndices: afterPages.map((p) => p.index).sort((a, b) => a - b),
        probeExistsBefore,
        probeExistsAfter,
      };
    });

    expect(outcome.beforeCount).toBe(3);
    expect(outcome.afterCount).toBe(2);
    expect(outcome.beforeBuildExists).toBe(true);
    expect(outcome.afterBuildExists).toBe(false);
    expect(outcome.remainingIndices).toEqual([0, 2]);
    expect(outcome.probeExistsBefore).toBe(true);
    expect(outcome.probeExistsAfter).toBe(false);
  });

  test("runFromStage after removePage only processes remaining pages", async ({
    page,
  }) => {
    const counts = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = await app.example.load();
      const project = await app.projects.createProjectFromBytes(
        "page-remove-rerun",
        bytes,
      );
      await app.render.ensurePageRows(project);
      await app.pipeline.runFromStage(
        (await app.projects.getProject(project.id))!,
        "all",
      );
      await app.projects.removePage(project.id, 1);

      const preBefore = window.__pdfPreprocessCallCount ?? 0;
      await app.pipeline.runFromStage(
        (await app.projects.getProject(project.id))!,
        "all",
      );
      const preAfter = window.__pdfPreprocessCallCount ?? 0;

      const finalBuild = (await app.projects.getProject(project.id))!.build;
      const pageCount = await app.render.getPageCount(
        await (await app.opfs.readBlob(finalBuild!.artifactPath))!.arrayBuffer(),
      );

      return {
        preprocessDelta: preAfter - preBefore,
        finalBuildPageCount: pageCount,
      };
    });

    // Preprocess was already cached for pages 0 and 2, so re-running the
    // pipeline shouldn't invoke the worker again. Build re-runs because
    // removePage invalidated it. The overlay approach preserves the
    // original source PDF's page count (3) — the removed page's image
    // stays but has no text overlay. This is the expected behaviour for
    // "overlay onto source" mode.
    expect(counts.preprocessDelta).toBe(0);
    expect(counts.finalBuildPageCount).toBe(3);
  });

  test("UI remove button + confirm dialog drops the page from the grid", async ({
    page,
  }) => {
    await page.getByTestId("load-example-synthetic").click();
    await page.getByTestId("run-stage-button").click();
    await expect(page.getByTestId("page-card-0")).toHaveAttribute(
      "data-ocr-status",
      "done",
      { timeout: 120_000 },
    );
    await expect(page.getByTestId("page-card-1")).toBeVisible();

    page.on("dialog", (d) => void d.accept());
    await page.getByTestId("page-remove-1").click();

    // Wait for the live-query update.
    await expect(page.getByTestId("page-card-1")).toBeHidden({ timeout: 5_000 });
    // Remaining cards re-render with sequential display indices.
    await expect(page.getByTestId("page-card-0")).toHaveAttribute(
      "data-display-index",
      "0",
    );
    await expect(page.getByTestId("page-card-2")).toHaveAttribute(
      "data-display-index",
      "1",
    );
  });
});
