import { expect, test, type Page } from "@playwright/test";

async function waitForHarness(page: Page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 10_000,
  });
}

async function bootstrapThroughPreprocess(page: Page, projectName: string) {
  return page.evaluate(async (name) => {
    const app = window.__pdfApp!;
    const bytes = await app.example.load();
    const project = await app.projects.createProjectFromBytes(name, bytes);
    await app.render.ensurePageRows(project);
    await app.render.runRenderPipeline((await app.projects.getProject(project.id))!);
    await app.preprocess.runPreprocessPipeline((await app.projects.getProject(project.id))!);
    return project.id;
  }, projectName);
}

test.describe("step 4 — text-region detection", () => {
  test.setTimeout(120_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
  });

  test("detect finds text blocks covering the expected text area", async ({ page }) => {
    const projectId = await bootstrapThroughPreprocess(page, "detect-ok");
    const stats = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const project = (await app.projects.getProject(id))!;
      await app.detect.runDetectPipeline(project);
      const result = await app.detect.readDetectRegions(id, 0);
      if (!result) throw new Error("no detect artifact");

      const pageArea = result.width * result.height;
      let unionArea = 0;
      let topmost = result.height;
      let bottommost = 0;
      let leftmost = result.width;
      let rightmost = 0;
      for (const r of result.regions) {
        unionArea += r.width * r.height;
        topmost = Math.min(topmost, r.y);
        bottommost = Math.max(bottommost, r.y + r.height);
        leftmost = Math.min(leftmost, r.x);
        rightmost = Math.max(rightmost, r.x + r.width);
      }
      return {
        count: result.regions.length,
        width: result.width,
        height: result.height,
        unionRatio: unionArea / pageArea,
        topRatio: topmost / result.height,
        bottomRatio: bottommost / result.height,
        leftRatio: leftmost / result.width,
        rightRatio: rightmost / result.width,
      };
    }, projectId);

    expect(stats.count).toBeGreaterThanOrEqual(3);
    // Fallback PDF has a heading plus ~6 body lines in the upper-left quadrant.
    expect(stats.topRatio).toBeLessThan(0.15);
    expect(stats.bottomRatio).toBeLessThan(0.75);
    expect(stats.leftRatio).toBeLessThan(0.2);
    expect(stats.rightRatio).toBeGreaterThan(0.4);
    expect(stats.unionRatio).toBeGreaterThan(0.05);
    expect(stats.unionRatio).toBeLessThan(0.5);
  });

  test("full pipeline surfaces detect-status=done on every page card", async ({ page }) => {
    await page.getByTestId("load-example-synthetic").click();
    await page.getByTestId("run-stage-button").click();
    await expect(page.getByTestId("page-card-0")).toHaveAttribute(
      "data-detect-status",
      "done",
      { timeout: 60_000 },
    );
    await expect(page.getByTestId("page-card-2")).toHaveAttribute(
      "data-detect-status",
      "done",
      { timeout: 60_000 },
    );
    // Overlay thumbnail has replaced the preprocessed thumbnail for at least
    // the first card (the detect stage writes overlayDataUrl into the row).
    const src = await page.getByTestId("page-thumb-0").getAttribute("src");
    expect(src).toMatch(/^data:image\/png;base64,/);
  });

  test("aborting before detect leaves no detect artifact", async ({ page }) => {
    const projectId = await bootstrapThroughPreprocess(page, "detect-abort");
    const outcome = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const project = (await app.projects.getProject(id))!;
      const controller = new AbortController();
      controller.abort();
      await app.detect.runDetectPipeline(project, { signal: controller.signal });
      const pages = await app.db.pages.where({ projectId: id }).toArray();
      return pages.map((p) => !!p.status.detect);
    }, projectId);
    expect(outcome.every((v) => v === false)).toBe(true);
  });

  test("rewind to preprocess drops detect artifacts too (downstream cascade)", async ({
    page,
  }) => {
    const projectId = await bootstrapThroughPreprocess(page, "detect-rewind");
    const outcome = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const project = (await app.projects.getProject(id))!;
      await app.detect.runDetectPipeline(project);
      const before = await app.db.pages.get(`${id}:0`);
      const detectPath = before?.status.detect?.artifactPath ?? null;
      await app.rewind.toStage(id, "preprocess");
      const after = await app.db.pages.get(`${id}:0`);
      const detectBlob = detectPath ? await app.opfs.readBlob(detectPath) : null;
      return {
        hadDetect: !!detectPath,
        detectAfter: !!after?.status.detect,
        preprocessAfter: !!after?.status.preprocess,
        renderAfter: !!after?.status.render,
        detectBlobNull: detectBlob === null,
      };
    }, projectId);
    expect(outcome.hadDetect).toBe(true);
    expect(outcome.detectAfter).toBe(false);
    expect(outcome.preprocessAfter).toBe(false);
    expect(outcome.renderAfter).toBe(true);
    expect(outcome.detectBlobNull).toBe(true);
  });
});
