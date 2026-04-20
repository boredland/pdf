import { expect, test, type Page } from "@playwright/test";

async function waitForHarness(page: Page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 10_000,
  });
}

async function bootstrap(page: Page, projectName: string) {
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

test.describe("step 3 — preprocess worker + rewind", () => {
  test.setTimeout(120_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
  });

  test("deskew corrects a synthetically rotated page to <0.5° residual", async ({ page }) => {
    const measurements = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = await app.example.load();
      const project = await app.projects.createProjectFromBytes("skew", bytes);
      await app.render.ensurePageRows(project);
      await app.render.runRenderPipeline((await app.projects.getProject(project.id))!);
      const row = await app.db.pages.get(`${project.id}:0`);
      if (!row?.status.render) throw new Error("no render artifact");

      const renderBlob = await app.opfs.readBlob(row.status.render.artifactPath);
      if (!renderBlob) throw new Error("render blob missing");
      const bitmap = await createImageBitmap(renderBlob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, bitmap.width, bitmap.height);
      ctx.translate(bitmap.width / 2, bitmap.height / 2);
      ctx.rotate((5 * Math.PI) / 180);
      ctx.translate(-bitmap.width / 2, -bitmap.height / 2);
      ctx.drawImage(bitmap, 0, 0);
      const skewedBlob = await canvas.convertToBlob({ type: "image/png" });
      const skewedBytes = await skewedBlob.arrayBuffer();
      await app.opfs.writeFile(row.status.render.artifactPath, new Uint8Array(skewedBytes));

      const initialSkew = await app.preprocess.measureSkew(skewedBytes);

      await app.preprocess.runPreprocessPipeline(
        (await app.projects.getProject(project.id))!,
      );

      const preRow = await app.db.pages.get(`${project.id}:0`);
      if (!preRow?.status.preprocess) throw new Error("no preprocess artifact");
      const outBlob = await app.opfs.readBlob(preRow.status.preprocess.artifactPath);
      if (!outBlob) throw new Error("preprocess blob missing");
      const outBytes = await outBlob.arrayBuffer();
      const residualSkew = await app.preprocess.measureSkew(outBytes);

      // Histogram check — expect binary output (mostly 0 and 255, little in-between).
      const bitmap2 = await createImageBitmap(outBlob);
      const c2 = new OffscreenCanvas(bitmap2.width, bitmap2.height);
      const x2 = c2.getContext("2d")!;
      x2.drawImage(bitmap2, 0, 0);
      const img = x2.getImageData(0, 0, bitmap2.width, bitmap2.height);
      let pure = 0;
      const sampleStep = 16;
      let total = 0;
      for (let i = 0; i < img.data.length; i += 4 * sampleStep) {
        const v = img.data[i]!;
        total++;
        if (v <= 5 || v >= 250) pure++;
      }
      return {
        initialSkew,
        residualSkew,
        pureRatio: pure / total,
      };
    });

    expect(Math.abs(measurements.initialSkew)).toBeGreaterThan(3);
    expect(Math.abs(measurements.residualSkew)).toBeLessThan(0.5);
    expect(measurements.pureRatio).toBeGreaterThan(0.97);
  });

  test("load-example pipeline flips page cards to preprocess:done with deskewed thumbnails", async ({
    page,
  }) => {
    await page.getByTestId("load-example-synthetic").click();
    await expect(page.getByTestId("page-card-0")).toHaveAttribute(
      "data-preprocess-status",
      "done",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("page-card-1")).toHaveAttribute(
      "data-preprocess-status",
      "done",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("page-thumb-0")).toBeVisible();
  });

  test("switching binarizer re-runs preprocess but not render", async ({ page }) => {
    const projectId = await bootstrap(page, "binarizer-switch");
    const counts = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const renderBefore = window.__pdfRenderCallCount ?? 0;
      const preBefore = window.__pdfPreprocessCallCount ?? 0;
      const project = (await app.projects.getProject(id))!;
      await app.db.projects.update(project.id, {
        settings: {
          ...project.settings,
          preprocess: { ...project.settings.preprocess, binarizer: "otsu" },
        },
      });
      const fresh = (await app.projects.getProject(project.id))!;
      await app.render.runRenderPipeline(fresh);
      await app.preprocess.runPreprocessPipeline(fresh);
      return {
        renderBefore,
        renderAfter: window.__pdfRenderCallCount ?? 0,
        preBefore,
        preAfter: window.__pdfPreprocessCallCount ?? 0,
        pageCount: fresh.pageCount,
      };
    }, projectId);

    expect(counts.renderAfter).toBe(counts.renderBefore);
    expect(counts.preAfter - counts.preBefore).toBeGreaterThanOrEqual(counts.pageCount);
  });

  test("rewind to preprocess deletes artifacts and clears Dexie status", async ({ page }) => {
    const projectId = await bootstrap(page, "rewind-check");
    const outcome = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const rowBefore = await app.db.pages.get(`${id}:0`);
      const path = rowBefore?.status?.preprocess?.artifactPath;
      if (!path) throw new Error("expected preprocess artifact before rewind");
      await app.rewind.toStage(id, "preprocess");
      const rowAfter = await app.db.pages.get(`${id}:0`);
      const blobAfter = await app.opfs.readBlob(path);
      return {
        hadPreprocessBefore: !!path,
        hasPreprocessAfter: !!rowAfter?.status?.preprocess,
        hasRenderAfter: !!rowAfter?.status?.render,
        blobAfterNull: blobAfter === null,
      };
    }, projectId);
    expect(outcome.hadPreprocessBefore).toBe(true);
    expect(outcome.hasPreprocessAfter).toBe(false);
    expect(outcome.hasRenderAfter).toBe(true);
    expect(outcome.blobAfterNull).toBe(true);
  });
});
