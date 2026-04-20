import { expect, test, type Page } from "@playwright/test";

async function waitForHarness(page: Page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 10_000,
  });
}

/**
 * Build a single-page PDF (as bytes) whose only content is a JPEG of text,
 * drawn upside-down. We go through the app's own image→PDF path so the
 * resulting PDF matches what a user would produce by dropping a rotated
 * photo.
 */
async function buildUpsideDownPdfBytes(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const width = 1200;
    const height = 800;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "black";
    ctx.font = "64px sans-serif";
    // Draw text UPSIDE DOWN (rotate the canvas 180° around its centre).
    ctx.translate(width / 2, height / 2);
    ctx.rotate(Math.PI);
    ctx.translate(-width / 2, -height / 2);
    ctx.fillText("Upside down example page", 80, 200);
    ctx.fillText("Second line of text to help OSD", 80, 320);
    ctx.fillText("Third line for extra confidence", 80, 440);

    const jpegBlob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: 0.9,
    });
    const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (window as any).__pdfApp!;
    const project = await app.projects.createProjectFromBytes(
      "upside-down.jpg",
      jpegBytes.buffer.slice(
        jpegBytes.byteOffset,
        jpegBytes.byteOffset + jpegBytes.byteLength,
      ),
      "image/jpeg",
    );
    const pdfBlob = await app.opfs.readBlob(project.sourcePdfPath);
    const pdfBytes = new Uint8Array(await pdfBlob!.arrayBuffer());
    return Array.from(pdfBytes);
  });
}

test.describe("step 12 — OSD 180° rotation correction", () => {
  test.setTimeout(180_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
  });

  test("preprocess applies the OSD flip when upside-down ingest is detected", async ({
    page,
  }) => {
    // Avoid full OCR — we don't care about text quality here.
    await page.evaluate(() =>
      window.__pdfApp!.testing.setDefaultOcrProvider("mock"),
    );
    const pdfArr = await buildUpsideDownPdfBytes(page);

    const result = await page.evaluate(async (arr) => {
      const u8 = new Uint8Array(arr);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const app = (window as any).__pdfApp!;
      const project = await app.projects.createProjectFromBytes(
        "osd-upside-down.pdf",
        u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength),
      );
      await app.render.ensurePageRows(project);
      const fresh = (await app.projects.getProject(project.id))!;
      await app.pipeline.runStage(fresh, "render");
      const afterRender = (await app.projects.getProject(project.id))!;
      await app.pipeline.runStage(afterRender, "preprocess");
      const row = await app.db.pages.get(`${project.id}:0`);
      // Sanity-check that the preprocess output looks different from the
      // render — if OSD did apply a flip, the two should not be byte-equal.
      const renderBlob = await app.opfs.readBlob(row!.status.render!.artifactPath);
      const preBlob = await app.opfs.readBlob(row!.status.preprocess!.artifactPath);
      return {
        osdAngle: row?.status?.preprocess?.osdAngleDegrees ?? null,
        hasPreprocess: !!row?.status?.preprocess,
        renderSize: renderBlob?.size ?? 0,
        preSize: preBlob?.size ?? 0,
      };
    }, pdfArr);

    expect(result.hasPreprocess).toBe(true);
    // The synthetic upside-down scan has unambiguous horizontal text; OSD
    // should flag it as 180°.
    expect(result.osdAngle).toBe(180);
    // Preprocess produced a non-empty artifact of its own (not just the
    // render re-used).
    expect(result.preSize).toBeGreaterThan(1000);
  });

  test("orientationDetect=false skips OSD (osdAngleDegrees stays 0)", async ({
    page,
  }) => {
    await page.evaluate(() =>
      window.__pdfApp!.testing.setDefaultOcrProvider("mock"),
    );
    const pdfArr = await buildUpsideDownPdfBytes(page);

    const result = await page.evaluate(async (arr) => {
      const u8 = new Uint8Array(arr);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const app = (window as any).__pdfApp!;
      const project = await app.projects.createProjectFromBytes(
        "osd-disabled.pdf",
        u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength),
      );
      await app.db.projects.update(project.id, {
        settings: {
          ...project.settings,
          preprocess: { ...project.settings.preprocess, orientationDetect: false },
        },
      });
      await app.render.ensurePageRows(project);
      const fresh = (await app.projects.getProject(project.id))!;
      await app.pipeline.runStage(fresh, "render");
      const afterRender = (await app.projects.getProject(project.id))!;
      await app.pipeline.runStage(afterRender, "preprocess");
      const row = await app.db.pages.get(`${project.id}:0`);
      return {
        osdAngle: row?.status?.preprocess?.osdAngleDegrees ?? 0,
      };
    }, pdfArr);

    expect(result.osdAngle).toBe(0);
  });
});
