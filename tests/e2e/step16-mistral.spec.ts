import { expect, test, type Page, type Route } from "@playwright/test";

const MISTRAL_URL = /api\.mistral\.ai\/v1\/ocr/;

async function waitForHarness(page: Page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 10_000,
  });
}

function mockMistral(page: Page, markdown: string, opts?: { fail?: boolean }) {
  return page.route(MISTRAL_URL, async (route: Route) => {
    if (opts?.fail) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ message: "invalid API key" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        pages: [
          { index: 0, markdown, dimensions: { width: 800, height: 1000 } },
        ],
      }),
    });
  });
}

async function bootstrapThroughPreprocess(page: Page, name: string) {
  return page.evaluate(async (projectName) => {
    const app = window.__pdfApp!;
    const bytes = await app.example.load();
    const project = await app.projects.createProjectFromBytes(projectName, bytes);
    await app.render.ensurePageRows(project);
    await app.render.runRenderPipeline(
      (await app.projects.getProject(project.id))!,
    );
    await app.preprocess.runPreprocessPipeline(
      (await app.projects.getProject(project.id))!,
    );
    return project.id;
  }, name);
}

async function enableMistral(page: Page, projectId: string) {
  await page.evaluate(async (id) => {
    const app = window.__pdfApp!;
    app.apiKeys.setPassphrase("test-pass");
    await app.apiKeys.store("mistral-ocr", "FAKE_MISTRAL_KEY", "test-pass");
    const project = (await app.projects.getProject(id))!;
    await app.db.projects.update(id, {
      settings: {
        ...project.settings,
        ocr: { ...project.settings.ocr, providerId: "mistral-ocr" },
      },
    });
  }, projectId);
}

test.describe("step 16 — Mistral OCR provider", () => {
  test.setTimeout(120_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
    await page.evaluate(() =>
      window.__pdfApp!.testing.setDefaultOrientationDetect(false),
    );
  });

  test("registry exposes Mistral as a hosted provider", async ({ page }) => {
    const providers = await page.evaluate(() =>
      window.__pdfApp!.ocr.listProviders().map((p) => ({
        id: p.id,
        kind: p.kind,
        label: p.label,
      })),
    );
    expect(providers).toContainEqual(
      expect.objectContaining({ id: "mistral-ocr", kind: "hosted" }),
    );
  });

  test("Mistral adapter turns a mocked response into a normalised OcrResult", async ({
    page,
  }) => {
    await mockMistral(
      page,
      ["# Page title", "First body line", "Second body line"].join("\n"),
    );
    const projectId = await bootstrapThroughPreprocess(page, "mistral-happy");
    await enableMistral(page, projectId);

    const result = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const project = (await app.projects.getProject(id))!;
      await app.ocr.runOcrPipeline(project, { pageIndices: [0] });
      return app.ocr.readOcrResult(id, 0);
    }, projectId);

    expect(result).not.toBeNull();
    expect(result!.providerId).toBe("mistral-ocr");
    // Markdown heading stripped, body lines remain.
    expect(result!.text).toContain("Page title");
    expect(result!.text).toContain("First body line");
    expect(result!.lines.length).toBeGreaterThanOrEqual(2);
    expect(result!.words.length).toBeGreaterThanOrEqual(4);
  });

  test("Mistral 401 surfaces as a stage failure with the provider message", async ({
    page,
  }) => {
    await mockMistral(page, "", { fail: true });
    const projectId = await bootstrapThroughPreprocess(page, "mistral-fail");
    await enableMistral(page, projectId);

    const error = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const project = (await app.projects.getProject(id))!;
      try {
        await app.ocr.runOcrPipeline(project, { pageIndices: [0] });
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    }, projectId);

    expect(error).toContain("invalid API key");
  });

  test("Mistral is listed in the API-keys panel provider dropdown", async ({
    page,
  }) => {
    await expect(
      page
        .getByTestId("api-keys-provider")
        .locator("option", { hasText: /Mistral/i }),
    ).toHaveCount(1);
  });
});
