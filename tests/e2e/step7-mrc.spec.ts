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

test.describe("step 7 — MRC split + compression", () => {
  test.setTimeout(180_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
    await page.evaluate(() => {
      window.__pdfApp!.testing.setDefaultOcrProvider("mock");
      window.__pdfApp!.testing.setDefaultOrientationDetect(false);
    });
  });

  test("presets order compact < archival <= lossless, compact stays small, round-trip fidelity holds", async ({
    page,
  }) => {
    const projectId = await bootstrapThroughPreprocess(page, "mrc-presets");
    const presets: Array<"compact" | "archival" | "lossless"> = [
      "compact",
      "archival",
      "lossless",
    ];
    const measurements = await page.evaluate(
      async ({ id, ps }) => {
        const app = window.__pdfApp!;
        const project = (await app.projects.getProject(id))!;
        const results: Record<string, { total: number; original: number; mad: number }> = {};
        for (const preset of ps) {
          await app.db.projects.update(project.id, {
            settings: { ...project.settings, mrc: { preset } },
          });
          const fresh = (await app.projects.getProject(project.id))!;
          await app.rewind.toStage(project.id, "mrc");
          await app.mrc.runMrcPipeline(fresh, { pageIndices: [0] });
          const manifest = await app.mrc.readMrcManifest(project.id, 0);
          if (!manifest) throw new Error(`no manifest for ${preset}`);
          results[preset] = {
            total: manifest.maskBytes + manifest.bgBytes,
            original: manifest.originalBytes,
            mad: manifest.meanAbsoluteDifference,
          };
        }
        return results;
      },
      { id: projectId, ps: presets },
    );

    const compact = measurements.compact!;
    const archival = measurements.archival!;
    const lossless = measurements.lossless!;

    expect(compact.total).toBeLessThan(archival.total);
    expect(archival.total).toBeLessThanOrEqual(lossless.total);
    // Absolute upper bound for this 3-page synthetic fixture. Scanned content
    // compresses *much* harder under MRC because the original PNG is fighting
    // high-frequency noise that JPEG handles far more efficiently. On our
    // mostly-white synthetic fixture, PNG is already near-optimal — so we bound
    // the compact output absolutely rather than relative to the tiny original.
    expect(compact.total).toBeLessThan(400 * 1024);

    for (const m of [compact, archival, lossless]) {
      expect(m.mad).toBeLessThan(25);
    }
  });

  test("full pipeline flips mrc-status=done on every card", async ({ page }) => {
    await page.getByTestId("load-example-synthetic").click();
    await page.getByTestId("run-stage-button").click();
    for (const idx of [0, 1, 2]) {
      await expect(page.getByTestId(`page-card-${idx}`)).toHaveAttribute(
        "data-mrc-status",
        "done",
        { timeout: 120_000 },
      );
    }
  });

  test("changing preset re-runs only mrc, not earlier stages", async ({ page }) => {
    const projectId = await bootstrapThroughPreprocess(page, "mrc-switch");
    const counts = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const project = (await app.projects.getProject(id))!;
      await app.mrc.runMrcPipeline(project, { pageIndices: [0] });
      const renderBefore = window.__pdfRenderCallCount ?? 0;
      const preBefore = window.__pdfPreprocessCallCount ?? 0;
      const mrcBefore = window.__pdfMrcCallCount ?? 0;

      await app.db.projects.update(id, {
        settings: { ...project.settings, mrc: { preset: "compact" } },
      });
      const fresh = (await app.projects.getProject(id))!;
      await app.render.runRenderPipeline(fresh, { pageIndices: [0] });
      await app.preprocess.runPreprocessPipeline(fresh, { pageIndices: [0] });
      await app.mrc.runMrcPipeline(fresh, { pageIndices: [0] });
      return {
        renderDelta: (window.__pdfRenderCallCount ?? 0) - renderBefore,
        preDelta: (window.__pdfPreprocessCallCount ?? 0) - preBefore,
        mrcDelta: (window.__pdfMrcCallCount ?? 0) - mrcBefore,
      };
    }, projectId);
    expect(counts.renderDelta).toBe(0);
    expect(counts.preDelta).toBe(0);
    expect(counts.mrcDelta).toBeGreaterThanOrEqual(1);
  });

  test("pre-aborted mrc run persists no artifact", async ({ page }) => {
    const projectId = await bootstrapThroughPreprocess(page, "mrc-abort");
    const rows = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const project = (await app.projects.getProject(id))!;
      const controller = new AbortController();
      controller.abort();
      await app.mrc.runMrcPipeline(project, { signal: controller.signal });
      const pages = await app.db.pages.where({ projectId: id }).toArray();
      return pages.map((p) => !!p.status.mrc);
    }, projectId);
    expect(rows.every((v) => v === false)).toBe(true);
  });

  test("mrc artifacts persist to OPFS and survive an offline reload", async ({
    page,
    context,
  }) => {
    const projectId = await bootstrapThroughPreprocess(page, "mrc-offline");
    const manifest = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const project = (await app.projects.getProject(id))!;
      await app.mrc.runMrcPipeline(project, { pageIndices: [0] });
      return await app.mrc.readMrcManifest(id, 0);
    }, projectId);
    expect(manifest).toBeTruthy();

    await context.setOffline(true);
    await page.reload();
    await waitForHarness(page);
    const reloaded = await page.evaluate(
      async ({ id, paths }) => {
        const app = window.__pdfApp!;
        const maskBlob = await app.opfs.readBlob(paths.mask);
        const bgBlob = await app.opfs.readBlob(paths.bg);
        const composedBlob = await app.opfs.readBlob(paths.composed);
        return {
          hasMask: (maskBlob?.size ?? 0) > 0,
          hasBg: (bgBlob?.size ?? 0) > 0,
          hasComposed: (composedBlob?.size ?? 0) > 0,
        };
      },
      {
        id: projectId,
        paths: {
          mask: manifest!.maskPath,
          bg: manifest!.bgPath,
          composed: manifest!.composedPath,
        },
      },
    );
    expect(reloaded.hasMask).toBe(true);
    expect(reloaded.hasBg).toBe(true);
    expect(reloaded.hasComposed).toBe(true);
    await context.setOffline(false);
  });
});
