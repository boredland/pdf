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

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

test.describe("step 5 — Tesseract OCR", () => {
  test.setTimeout(180_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
  });

  test("OCR on fixture page 0 recovers the known text within 10% character error rate", async ({
    page,
  }) => {
    const projectId = await bootstrapThroughPreprocess(page, "ocr-text");
    const text = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const project = (await app.projects.getProject(id))!;
      await app.ocr.runOcrPipeline(project, { pageIndices: [0] });
      const result = await app.ocr.readOcrResult(id, 0);
      if (!result) throw new Error("no ocr result");
      return result.text;
    }, projectId);

    const expected =
      "Page 1\n\nThis is the bundled fallback example PDF used by the app during\ndevelopment and by the Playwright test suite. Production builds\noverlay this file with the smallest PDF from NARA record 12044361\nvia scripts/resolve-example-pdf.ts.\n\nSynthetic page 1 of 3.";
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    const distance = levenshtein(norm(text), norm(expected));
    const cer = distance / norm(expected).length;
    expect(cer).toBeLessThan(0.1);
  });

  test("OCR writes a result artifact with words+confidence", async ({ page }) => {
    const projectId = await bootstrapThroughPreprocess(page, "ocr-words");
    const metrics = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const project = (await app.projects.getProject(id))!;
      await app.ocr.runOcrPipeline(project, { pageIndices: [0] });
      const r = await app.ocr.readOcrResult(id, 0);
      if (!r) throw new Error("missing result");
      const knownWord = r.words.find((w) => /Page/i.test(w.text));
      return {
        wordCount: r.words.length,
        lineCount: r.lines.length,
        avgConfidence:
          r.words.reduce((s, w) => s + w.confidence, 0) / (r.words.length || 1),
        knownWordBbox: knownWord?.bbox,
        knownWordConf: knownWord?.confidence,
      };
    }, projectId);
    expect(metrics.wordCount).toBeGreaterThan(10);
    expect(metrics.avgConfidence).toBeGreaterThan(0.6);
    expect(metrics.knownWordBbox).toBeDefined();
    expect(metrics.knownWordConf ?? 0).toBeGreaterThan(0.4);
  });

  test("full pipeline surfaces ocr-status=done for every page", async ({ page }) => {
    await page.getByTestId("load-example-synthetic").click();
    for (const idx of [0, 1, 2]) {
      await expect(page.getByTestId(`page-card-${idx}`)).toHaveAttribute(
        "data-ocr-status",
        "done",
        { timeout: 120_000 },
      );
    }
  });

  test("pre-aborted OCR writes no artifact", async ({ page }) => {
    const projectId = await bootstrapThroughPreprocess(page, "ocr-abort");
    const rows = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const project = (await app.projects.getProject(id))!;
      const controller = new AbortController();
      controller.abort();
      await app.ocr.runOcrPipeline(project, { signal: controller.signal });
      const pages = await app.db.pages.where({ projectId: id }).toArray();
      return pages.map((p) => !!p.status.ocr);
    }, projectId);
    expect(rows.every((v) => v === false)).toBe(true);
  });

  test("tesseract assets are cached by the SW; offline reload can still init OCR", async ({
    page,
    context,
  }) => {
    // Warm the caches first.
    await page.getByTestId("load-example-synthetic").click();
    await expect(page.getByTestId("page-card-0")).toHaveAttribute(
      "data-ocr-status",
      "done",
      { timeout: 120_000 },
    );

    const cached = await page.evaluate(async () => {
      const hits: string[] = [];
      const names = await caches.keys();
      for (const name of names) {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        for (const req of keys) {
          if (/tesseract/.test(req.url) || /traineddata/.test(req.url)) {
            hits.push(req.url);
          }
        }
      }
      return hits;
    });
    expect(cached.length).toBeGreaterThan(0);

    await context.setOffline(true);
    await page.reload();
    await waitForHarness(page);

    const offlineOcr = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = await app.example.load();
      const project = await app.projects.createProjectFromBytes("offline", bytes);
      await app.render.ensurePageRows(project);
      await app.render.runRenderPipeline((await app.projects.getProject(project.id))!);
      await app.preprocess.runPreprocessPipeline((await app.projects.getProject(project.id))!);
      await app.ocr.runOcrPipeline(
        (await app.projects.getProject(project.id))!,
        { pageIndices: [0] },
      );
      const result = await app.ocr.readOcrResult(project.id, 0);
      return { words: result?.words?.length ?? 0 };
    });
    expect(offlineOcr.words).toBeGreaterThan(5);
    await context.setOffline(false);
  });
});
