import { expect, test, type Page, type Route } from "@playwright/test";

const GEMINI_URL = /generativelanguage\.googleapis\.com\/.*generateContent/;

async function waitForHarness(page: Page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 10_000,
  });
}

function mockGemini(page: Page, text: string) {
  return page.route(GEMINI_URL, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text }],
            },
          },
        ],
      }),
    });
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

async function enableGemini(page: Page, projectId: string) {
  await page.evaluate(async (id) => {
    const app = window.__pdfApp!;
    app.apiKeys.setPassphrase("test-pass");
    await app.apiKeys.store("gemini-flash", "FAKE_KEY_123", "test-pass");
    const project = (await app.projects.getProject(id))!;
    await app.db.projects.update(id, {
      settings: { ...project.settings, ocr: { ...project.settings.ocr, providerId: "gemini-flash" } },
    });
  }, projectId);
}

test.describe("step 6 — Gemini provider", () => {
  test.setTimeout(120_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
  });

  test("gemini recognize returns OcrResult shape with expected text", async ({ page }) => {
    const projectId = await bootstrapThroughPreprocess(page, "gemini-ok");
    await enableGemini(page, projectId);
    await mockGemini(page, "Page 1\nMocked text body\nMore text");

    const result = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const project = (await app.projects.getProject(id))!;
      await app.ocr.runOcrPipeline(project, { pageIndices: [0] });
      const r = await app.ocr.readOcrResult(id, 0);
      return {
        providerId: r?.providerId,
        text: r?.text,
        wordCount: r?.words?.length,
        lineCount: r?.lines?.length,
      };
    }, projectId);

    expect(result.providerId).toBe("gemini-flash");
    expect(result.text).toContain("Page 1");
    expect(result.text).toContain("Mocked text body");
    expect(result.lineCount).toBe(3);
    expect(result.wordCount).toBeGreaterThan(3);
  });

  test("switching provider invalidates only the OCR stage, not render/preprocess/detect", async ({
    page,
  }) => {
    const projectId = await bootstrapThroughPreprocess(page, "gemini-switch");
    await mockGemini(page, "Page 1 mocked output");

    // Run Tesseract first, then swap to Gemini and re-run. Render/preprocess/
    // detect artifacts must be untouched (hash and path unchanged).
    const outcome = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      await app.ocr.runOcrPipeline((await app.projects.getProject(id))!, {
        pageIndices: [0],
      });
      await app.detect.runDetectPipeline((await app.projects.getProject(id))!);
      const before = await app.db.pages.get(`${id}:0`);

      app.apiKeys.setPassphrase("p");
      await app.apiKeys.store("gemini-flash", "FAKE_KEY_123", "p");
      const project = (await app.projects.getProject(id))!;
      await app.db.projects.update(id, {
        settings: {
          ...project.settings,
          ocr: { ...project.settings.ocr, providerId: "gemini-flash" },
        },
      });
      const renderBefore = window.__pdfRenderCallCount ?? 0;
      const preBefore = window.__pdfPreprocessCallCount ?? 0;
      const detectBefore = window.__pdfDetectCallCount ?? 0;

      await app.ocr.runOcrPipeline((await app.projects.getProject(id))!, {
        pageIndices: [0],
      });
      const after = await app.db.pages.get(`${id}:0`);
      return {
        renderSame: before?.status.render?.artifactPath === after?.status.render?.artifactPath,
        renderHashSame: before?.status.render?.hash === after?.status.render?.hash,
        preprocessSame:
          before?.status.preprocess?.artifactPath === after?.status.preprocess?.artifactPath,
        detectSame: before?.status.detect?.artifactPath === after?.status.detect?.artifactPath,
        ocrHashChanged: before?.status.ocr?.hash !== after?.status.ocr?.hash,
        renderCalls: (window.__pdfRenderCallCount ?? 0) - renderBefore,
        preCalls: (window.__pdfPreprocessCallCount ?? 0) - preBefore,
        detectCalls: (window.__pdfDetectCallCount ?? 0) - detectBefore,
        providerAfter: after?.status.ocr ? (await app.ocr.readOcrResult(id, 0))?.providerId : null,
      };
    }, projectId);

    expect(outcome.renderSame).toBe(true);
    expect(outcome.renderHashSame).toBe(true);
    expect(outcome.preprocessSame).toBe(true);
    expect(outcome.detectSame).toBe(true);
    expect(outcome.ocrHashChanged).toBe(true);
    expect(outcome.renderCalls).toBe(0);
    expect(outcome.preCalls).toBe(0);
    expect(outcome.detectCalls).toBe(0);
    expect(outcome.providerAfter).toBe("gemini-flash");
  });

  test("gemini refuses to dispatch without a key", async ({ page }) => {
    const projectId = await bootstrapThroughPreprocess(page, "gemini-nokey");
    const err = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      app.apiKeys.clearPassphrase();
      const project = (await app.projects.getProject(id))!;
      await app.db.projects.update(id, {
        settings: { ...project.settings, ocr: { ...project.settings.ocr, providerId: "gemini-flash" } },
      });
      try {
        await app.ocr.runOcrPipeline((await app.projects.getProject(id))!, {
          pageIndices: [0],
        });
        return { message: null };
      } catch (e) {
        return { message: (e as Error).message };
      }
    }, projectId);
    expect(err.message).toMatch(/key/i);
    const hasArtifact = await page.evaluate(async (id) => {
      const row = await window.__pdfApp!.db.pages.get(`${id}:0`);
      return !!row?.status.ocr;
    }, projectId);
    expect(hasArtifact).toBe(false);
  });

  test("aborting mid-gemini-request persists no artifact", async ({ page }) => {
    const projectId = await bootstrapThroughPreprocess(page, "gemini-abort");
    await enableGemini(page, projectId);

    let fulfillCount = 0;
    await page.route(GEMINI_URL, async (route) => {
      fulfillCount++;
      // Hold the request so we can abort in the meantime.
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          candidates: [{ content: { parts: [{ text: "late response" }] } }],
        }),
      });
    });

    const outcome = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const project = (await app.projects.getProject(id))!;
      const controller = new AbortController();
      const pending = app.ocr.runOcrPipeline(project, {
        signal: controller.signal,
        pageIndices: [0],
      });
      await new Promise((r) => setTimeout(r, 200));
      controller.abort();
      try {
        await pending;
      } catch {
        // expected (AbortError surfaces from fetch)
      }
      const row = await app.db.pages.get(`${id}:0`);
      return { hasOcr: !!row?.status.ocr };
    }, projectId);

    expect(outcome.hasOcr).toBe(false);
    expect(fulfillCount).toBeGreaterThan(0);
  });

  test("UI: api-keys panel flips unlocked state after passphrase + key save", async ({
    page,
  }) => {
    await page.getByTestId("load-example-synthetic").click();
    const panel = page.getByTestId("api-keys-panel");
    await expect(panel).toBeVisible();
    await page.getByTestId("api-keys-passphrase").fill("hunter2");
    await page.getByTestId("api-keys-provider").selectOption("gemini-flash");
    await page.getByTestId("api-keys-value").fill("FAKE_UI_KEY");
    await page.getByTestId("api-keys-save").click();
    await expect(page.getByTestId("api-keys-unlocked")).toBeVisible();
    await expect(page.getByText("gemini-flash")).toBeVisible();
  });
});
