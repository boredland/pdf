import { expect, test, type Page } from "@playwright/test";

async function waitForHarness(page: Page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 10_000,
  });
}

async function bootstrapProject(page: Page) {
  await page.getByTestId("load-example-synthetic").click();
  await page.getByTestId("run-stage-button").click();
  await expect(page.getByTestId("page-card-0")).toHaveAttribute(
    "data-render-status",
    "done",
    { timeout: 60_000 },
  );
}

test.describe("languages — selector + download UI", () => {
  test.setTimeout(120_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
  });

  test("languages panel lists entries; English is always cached", async ({ page }) => {
    await bootstrapProject(page);
    const panel = page.getByTestId("languages-panel");
    await expect(panel).toBeVisible();

    await expect(page.getByTestId("lang-row-eng")).toHaveAttribute(
      "data-cache-state",
      "cached",
    );
    await expect(page.getByTestId("lang-status-eng")).toHaveText("cached");
    await expect(page.getByTestId("lang-check-eng")).toBeChecked();

    // At least a handful of non-English languages are listed.
    for (const code of ["deu", "fra", "rus", "jpn"]) {
      await expect(page.getByTestId(`lang-row-${code}`)).toBeVisible();
    }
  });

  test("download button warms the SW cache for a non-English language", async ({
    page,
    context,
  }) => {
    // Must use context.route (not page.route) — service-worker-initiated
    // fetches bypass per-page routing.
    await context.route(/tessdata\.projectnaptha\.com.*deu\.traineddata\.gz$/, async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=31536000",
        },
        body: Buffer.alloc(2048, 0x61),
      });
    });
    await bootstrapProject(page);

    await expect(page.getByTestId("lang-row-deu")).toHaveAttribute(
      "data-cache-state",
      "missing",
    );
    await page.getByTestId("lang-download-deu").click();
    await expect
      .poll(
        async () =>
          (await page.getByTestId("lang-row-deu").getAttribute("data-cache-state")) ?? "",
        { timeout: 10_000 },
      )
      .toBe("cached");

    const hits = await page.evaluate(async () => {
      const results: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const req of await cache.keys()) {
          if (req.url.endsWith("deu.traineddata.gz")) results.push(req.url);
        }
      }
      return results;
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  test("checkbox toggles write project.settings.ocr.language as +-joined code", async ({
    page,
    context,
  }) => {
    await context.route(/tessdata\.projectnaptha\.com.*deu\.traineddata\.gz$/, async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=31536000",
        },
        body: Buffer.alloc(2048, 0x62),
      });
    });
    await bootstrapProject(page);
    await page.getByTestId("lang-download-deu").click();
    await expect(page.getByTestId("lang-row-deu")).toHaveAttribute(
      "data-cache-state",
      "cached",
      { timeout: 10_000 },
    );

    await expect(page.getByTestId("lang-check-deu")).not.toBeDisabled({
      timeout: 10_000,
    });
    // .check() would fail on the controlled-input round-trip through Dexie;
    // .click() just dispatches the event and lets the next .poll verify.
    await page.getByTestId("lang-check-deu").click();

    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const projects = await window.__pdfApp!.projects.listProjects();
            return projects[0]?.settings.ocr.language ?? "";
          }),
        { timeout: 5_000 },
      )
      .toMatch(/eng\+deu|deu\+eng/);

    await expect(page.getByTestId("lang-check-deu")).not.toBeDisabled();
    await page.getByTestId("lang-check-deu").click();
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const projects = await window.__pdfApp!.projects.listProjects();
            return projects[0]?.settings.ocr.language ?? "";
          }),
        { timeout: 5_000 },
      )
      .toBe("eng");
  });

  test("checkbox is disabled for languages that aren't cached yet", async ({ page }) => {
    await bootstrapProject(page);
    await expect(page.getByTestId("lang-row-chi_sim")).toHaveAttribute(
      "data-cache-state",
      "missing",
    );
    await expect(page.getByTestId("lang-check-chi_sim")).toBeDisabled();
  });

  test("langPathFor routes eng-only to local, anything else to CDN", async ({ page }) => {
    const result = await page.evaluate(async () => {
      // Harness surface doesn't export langPathFor directly — exercise via
      // the behaviour exposed through downloadLanguage's URL builder.
      const app = window.__pdfApp!;
      return {
        engUrl: app.languages.url("eng"),
        deuUrl: app.languages.url("deu"),
      };
    });
    expect(result.engUrl).toContain("/tesseract/eng.traineddata");
    expect(result.deuUrl).toContain("tessdata.projectnaptha.com");
    expect(result.deuUrl).toContain("deu.traineddata.gz");
  });
});

test.describe("detail pane — detect tab overlay", () => {
  test.setTimeout(180_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
  });

  test("detect tab image is the overlay PNG with drawn bboxes", async ({ page }) => {
    await page.getByTestId("load-example-synthetic").click();
    await page.getByTestId("run-stage-button").click();
    await expect(page.getByTestId("page-card-0")).toHaveAttribute(
      "data-detect-status",
      "done",
      { timeout: 120_000 },
    );
    await page.getByTestId("page-open-0").click();
    await page.getByTestId("detail-tab-detect").click();
    const img = page.getByTestId("detail-image");
    await expect(img).toBeVisible();
    const src = await img.getAttribute("src");
    expect(src).toMatch(/^blob:/);

    // Verify the underlying blob corresponds to a PNG whose path is the
    // detect-overlay.*.png artifact (not the raw render).
    const overlayInfo = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const projects = await app.projects.listProjects();
      const row = await app.db.pages.get(`${projects[0]!.id}:0`);
      return {
        overlayPath: row?.status.detect?.overlayPath ?? null,
        renderPath: row?.status.render?.artifactPath ?? null,
      };
    });
    expect(overlayInfo.overlayPath).toMatch(/detect-overlay\./);
    expect(overlayInfo.overlayPath).not.toEqual(overlayInfo.renderPath);
  });
});
