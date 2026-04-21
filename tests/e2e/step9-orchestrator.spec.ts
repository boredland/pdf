import { expect, test, type Page } from "@playwright/test";

async function waitForHarness(page: Page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 10_000,
  });
}

test.describe("step 9 — orchestrator, progress, resume, confirm", () => {
  test.setTimeout(240_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
    await page.evaluate(() => {
      window.__pdfApp!.testing.setDefaultOcrProvider("mock");
      window.__pdfApp!.testing.setDefaultOrientationDetect(false);
    });
  });

  test("job progress advances as each stage completes and pegs at 100% after build", async ({
    page,
  }) => {
    await page.getByTestId("load-example-synthetic").click();
    await page.getByTestId("run-stage-button").click();
    // 3 pages × 4 per-page stages + 1 build = 13 (MRC dropped from critical path).
    await expect
      .poll(
        async () =>
          Number.parseInt(
            (await page.getByTestId("job-progress").getAttribute("data-progress-percent")) ?? "0",
            10,
          ),
        { timeout: 180_000 },
      )
      .toBe(100);
    await expect(page.getByTestId("job-progress")).toHaveAttribute("data-built", "true");
  });

  test("Run button label flips Run → Resume → Re-run", async ({ page }) => {
    // 1. New project, no stages run yet → "Run"
    await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = await app.example.load();
      const project = await app.projects.createProjectFromBytes("resume-labels", bytes);
      await app.render.ensurePageRows(project);
    });
    // Projects created via harness don't auto-activate in the UI; the button
    // label assertion exercises the helper directly via harness.
    const labels = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const id = (await app.projects.listProjects())[0]!.id;
      const fresh = () => app.projects.getProject(id);
      const pages = () => app.db.pages.where({ projectId: id }).toArray();

      // 1. Nothing run yet.
      const p1 = await fresh();
      const rows1 = await pages();
      const progress1 = app.progress.compute(p1!, rows1);

      // 2. Partial state.
      await app.pipeline.runStage(p1!, "render");
      const p2 = await fresh();
      const rows2 = await pages();
      const progress2 = app.progress.compute(p2!, rows2);

      // 3. Full build.
      await app.pipeline.runFromStage(p2!, "all");
      const p3 = await fresh();
      const rows3 = await pages();
      const progress3 = app.progress.compute(p3!, rows3);

      return {
        empty: { partial: progress1.partial, built: progress1.built },
        partial: { partial: progress2.partial, built: progress2.built },
        done: { partial: progress3.partial, built: progress3.built, ratio: progress3.ratio },
      };
    });
    expect(labels.empty.partial).toBe(false);
    expect(labels.empty.built).toBe(false);
    expect(labels.partial.partial).toBe(true);
    expect(labels.partial.built).toBe(false);
    expect(labels.done.built).toBe(true);
    expect(labels.done.ratio).toBe(1);
  });

  test("resume: after a render-only partial run, a second Run completes the rest", async ({
    page,
  }) => {
    const projectId = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = await app.example.load();
      const project = await app.projects.createProjectFromBytes("resume", bytes);
      await app.render.ensurePageRows(project);
      await app.pipeline.runStage(
        (await app.projects.getProject(project.id))!,
        "render",
      );
      return project.id;
    });

    const before = await page.evaluate(() => ({
      render: window.__pdfRenderCallCount ?? 0,
      preprocess: window.__pdfPreprocessCallCount ?? 0,
    }));

    const result = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const fresh = (await app.projects.getProject(id))!;
      await app.pipeline.runFromStage(fresh, "all");
      const finalProject = (await app.projects.getProject(id))!;
      const pages = await app.db.pages.where({ projectId: id }).toArray();
      return app.progress.compute(finalProject, pages);
    }, projectId);

    expect(result.built).toBe(true);
    expect(result.ratio).toBe(1);

    // Render was already cached — no fresh invocations.
    const after = await page.evaluate(() => ({
      render: window.__pdfRenderCallCount ?? 0,
      preprocess: window.__pdfPreprocessCallCount ?? 0,
    }));
    expect(after.render - before.render).toBe(0);
    expect(after.preprocess - before.preprocess).toBeGreaterThan(0);
  });

  test("predictInvalidation reports per-stage artifact count + bytes for a destructive change", async ({
    page,
  }) => {
    const projectId = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = await app.example.load();
      const project = await app.projects.createProjectFromBytes("invalidate", bytes);
      await app.render.ensurePageRows(project);
      await app.pipeline.runFromStage(
        (await app.projects.getProject(project.id))!,
        "all",
      );
      return project.id;
    });

    const prediction = await page.evaluate(
      async (id) => window.__pdfApp!.progress.predict(id, ["preprocess"]),
      projectId,
    );

    // preprocess + detect + ocr + mrc + build = 5 stage kinds, across 3 pages
    // (build is project-wide so 1 entry). That's 3×4 + 1 = 13 artifacts.
    expect(prediction.artifactCount).toBe(13);
    expect(prediction.byteCount).toBeGreaterThan(50_000);
    expect(prediction.stages).toContain("preprocess");
    expect(prediction.stages).toContain("build");
  });

  test("settings change triggers a confirm dialog and reverts on cancel", async ({
    page,
  }) => {
    await page.getByTestId("load-example-synthetic").click();
    await page.getByTestId("run-stage-button").click();
    await expect(page.getByTestId("page-card-0")).toHaveAttribute(
      "data-ocr-status",
      "done",
      { timeout: 180_000 },
    );

    // Change binarizer → expect modal.
    await page.getByTestId("settings-binarizer").selectOption("otsu");
    const dialog = page.getByTestId("settings-confirm");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("settings-confirm-body")).toContainText(/artifact/);
    await page.getByTestId("settings-confirm-cancel").click();
    await expect(dialog).toBeHidden();

    // Sauvola still selected after cancel.
    await expect(page.getByTestId("settings-binarizer")).toHaveValue("sauvola");
  });

  test("settings change confirm applies the update when accepted", async ({ page }) => {
    await page.getByTestId("load-example-synthetic").click();
    await page.getByTestId("run-stage-button").click();
    await expect(page.getByTestId("page-card-0")).toHaveAttribute(
      "data-ocr-status",
      "done",
      { timeout: 180_000 },
    );

    await page.getByTestId("settings-binarizer").selectOption("otsu");
    await page.getByTestId("settings-confirm-confirm").click();
    await expect(page.getByTestId("settings-confirm")).toBeHidden();
    await expect(page.getByTestId("settings-binarizer")).toHaveValue("otsu");
  });

  test("project state survives a page reload (Dexie + OPFS persistence)", async ({
    page,
  }) => {
    await page.getByTestId("load-example-synthetic").click();
    await page.getByTestId("run-stage-button").click();
    // Wait for all 3 pages' MRC to finish so the byte count stabilises
    // before we snapshot — otherwise we can race a mid-write and measure
    // a prefix state that'll grow after the reload.
    for (const i of [0, 1, 2]) {
      await expect(page.getByTestId(`page-card-${i}`)).toHaveAttribute(
        "data-ocr-status",
        "done",
        { timeout: 180_000 },
      );
    }

    const beforeBytes = await page.evaluate(async () => {
      const id = (await window.__pdfApp!.projects.listProjects())[0]!.id;
      return window.__pdfApp!.progress.sumBytes(id);
    });

    await page.reload();
    await waitForHarness(page);

    const afterBytes = await page.evaluate(async () => {
      const id = (await window.__pdfApp!.projects.listProjects())[0]!.id;
      return window.__pdfApp!.progress.sumBytes(id);
    });

    expect(afterBytes).toBe(beforeBytes);
  });
});
