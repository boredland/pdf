import { expect, test, type Page } from "@playwright/test";

async function waitForHarness(page: Page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 10_000,
  });
}

async function bootstrapAllStages(page: Page, projectName: string) {
  return page.evaluate(async (name) => {
    const app = window.__pdfApp!;
    const bytes = await app.example.load();
    const project = await app.projects.createProjectFromBytes(name, bytes);
    await app.render.ensurePageRows(project);
    await app.pipeline.runFromStage(
      (await app.projects.getProject(project.id))!,
      "all",
    );
    return project.id;
  }, projectName);
}

test.describe("step 8 — searchable PDF builder", () => {
  test.setTimeout(240_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
    // Default to the mock OCR provider: every test here except the one
    // asserting round-tripped real text opts in individually if it needs
    // Tesseract. Turn off OSD too — these specs exercise pipeline plumbing,
    // not orientation detection.
    await page.evaluate(() => {
      window.__pdfApp!.testing.setDefaultOcrProvider("mock");
      window.__pdfApp!.testing.setDefaultOrientationDetect(false);
    });
  });

  test("build produces a valid PDF with an invisible text layer that mupdf can read", async ({
    page,
  }) => {
    const projectId = await bootstrapAllStages(page, "build-basic");

    const probe = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const blob = await app.build.readBuildOutput(id);
      if (!blob) return null;
      const first = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
      const bytes = await blob.arrayBuffer();
      const pageCount = await app.render.getPageCount(bytes);
      return {
        pageCount,
        header: Array.from(first).map((b) => b.toString(16).padStart(2, "0")).join(""),
        sizeBytes: blob.size,
        totalBuildCalls: window.__pdfBuildCallCount ?? 0,
      };
    }, projectId);

    expect(probe).not.toBeNull();
    expect(probe!.sizeBytes).toBeGreaterThan(5_000);
    // PDF magic: "%PDF-"
    expect(probe!.header).toBe("255044462d");
    expect(probe!.pageCount).toBe(3);
    // Build was invoked at least once during the bootstrap's runFromStage("all").
    expect(probe!.totalBuildCalls).toBeGreaterThanOrEqual(1);
  });

  test("invisible text is extractable from the built PDF", async ({ page }) => {
    // This test verifies real OCR text round-trips through the invisible
    // layer, so it must use Tesseract rather than the mock default.
    await page.evaluate(() =>
      window.__pdfApp!.testing.setDefaultOcrProvider("tesseract"),
    );
    const projectId = await bootstrapAllStages(page, "build-text");

    const extracted = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const project = (await app.projects.getProject(id))!;
      await app.build.runBuildPipeline(project);
      const blob = await app.build.readBuildOutput(id);
      if (!blob) return null;

      const bytes = await blob.arrayBuffer();
      return app.pdfInspect.extractText(bytes);
    }, projectId);

    expect(extracted).not.toBeNull();
    expect(extracted!.length).toBe(3);
    // All three synthetic pages end with "of 3." — catch the pattern.
    const joined = extracted!.join("\n");
    // Tesseract on the tiny synthetic fixture isn't pixel-perfect; assert that
    // at least some of the expected words round-tripped through the invisible
    // text layer.
    const recognisable = ["Page", "bundled", "example", "PDF", "fallback", "Synthetic"];
    const hits = recognisable.filter((word) =>
      new RegExp(word, "i").test(joined),
    );
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  test("changing OCR provider for one page re-runs OCR + build, not earlier stages", async ({
    page,
  }) => {
    const projectId = await bootstrapAllStages(page, "build-reocr");

    // Mock Gemini so we can swap the provider without a real key.
    await page.context().route(
      /generativelanguage\.googleapis\.com\/.*generateContent/,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Gemini page text" }] } }],
          }),
        });
      },
    );

    const counts = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const before = {
        render: window.__pdfRenderCallCount ?? 0,
        preprocess: window.__pdfPreprocessCallCount ?? 0,
        mrc: window.__pdfMrcCallCount ?? 0,
        build: window.__pdfBuildCallCount ?? 0,
      };

      // Swap provider to Gemini for page 0 only.
      app.apiKeys.setPassphrase("p");
      await app.apiKeys.store("gemini-flash", "FAKE", "p");
      const project = (await app.projects.getProject(id))!;
      await app.db.projects.update(id, {
        settings: { ...project.settings, ocr: { ...project.settings.ocr, providerId: "gemini-flash" } },
      });

      const fresh = (await app.projects.getProject(id))!;
      await app.ocr.runOcrPipeline(fresh, { pageIndices: [0] });
      await app.build.runBuildPipeline((await app.projects.getProject(id))!);

      return {
        renderDelta: (window.__pdfRenderCallCount ?? 0) - before.render,
        preDelta: (window.__pdfPreprocessCallCount ?? 0) - before.preprocess,
        mrcDelta: (window.__pdfMrcCallCount ?? 0) - before.mrc,
        buildDelta: (window.__pdfBuildCallCount ?? 0) - before.build,
      };
    }, projectId);

    expect(counts.renderDelta).toBe(0);
    expect(counts.preDelta).toBe(0);
    expect(counts.mrcDelta).toBe(0);
    expect(counts.buildDelta).toBe(1);
  });

  test("cached build short-circuits when settings haven't changed", async ({ page }) => {
    const projectId = await bootstrapAllStages(page, "build-cache");
    const counts = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const project = (await app.projects.getProject(id))!;
      await app.build.runBuildPipeline(project);
      const before = window.__pdfBuildCallCount ?? 0;
      await app.build.runBuildPipeline((await app.projects.getProject(id))!);
      return { delta: (window.__pdfBuildCallCount ?? 0) - before };
    }, projectId);
    expect(counts.delta).toBe(0);
  });

  test("UI: Download PDF button appears after build completes and links to the artifact", async ({
    page,
  }) => {
    await page.getByTestId("load-example-synthetic").click();
    await page.getByTestId("run-stage-button").click();
    await expect(page.getByTestId("download-pdf")).toBeVisible({ timeout: 180_000 });
  });
});
