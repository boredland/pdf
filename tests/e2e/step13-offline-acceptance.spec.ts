import { expect, test, type Page } from "@playwright/test";

async function waitForHarness(page: Page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 10_000,
  });
}

async function waitForSwActive(page: Page) {
  await page.waitForFunction(
    async () => {
      if (!("serviceWorker" in navigator)) return false;
      const reg = await navigator.serviceWorker.ready;
      return reg.active !== null;
    },
    null,
    { timeout: 10_000 },
  );
}

/**
 * Cold-load acceptance: build a project online, reload offline, re-run one
 * page, download the final PDF. This is the gate that protects the app's
 * "fully offline once cached" promise.
 */
test.describe("step 13 — offline acceptance", () => {
  test.setTimeout(180_000);

  test("online bootstrap → reload offline → re-run a page → export", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await waitForHarness(page);
    await waitForSwActive(page);

    // Keep the run cheap: mock OCR + no OSD.
    await page.evaluate(() => {
      window.__pdfApp!.testing.setDefaultOcrProvider("mock");
      window.__pdfApp!.testing.setDefaultOrientationDetect(false);
    });

    // Bootstrap via harness: create a project from the synthetic fixture
    // and run the full pipeline through build.
    const projectId = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = await app.example.load();
      const project = await app.projects.createProjectFromBytes(
        "offline-smoke",
        bytes,
      );
      await app.render.ensurePageRows(project);
      const fresh = (await app.projects.getProject(project.id))!;
      await app.pipeline.runFromStage(fresh, "all");
      return project.id;
    });

    // Sanity: project has a build artifact online.
    const preOffline = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const p = await app.projects.getProject(id);
      const pages = await app.db.pages.where({ projectId: id }).toArray();
      const progress = app.progress.compute(p!, pages);
      return { built: progress.built, ratio: progress.ratio };
    }, projectId);
    expect(preOffline.built).toBe(true);
    expect(preOffline.ratio).toBe(1);

    // Flip offline, reload, verify everything comes back.
    await context.setOffline(true);
    await page.reload();
    await waitForHarness(page);

    // Re-apply the testing defaults post-reload (they don't persist).
    await page.evaluate(() => {
      window.__pdfApp!.testing.setDefaultOcrProvider("mock");
      window.__pdfApp!.testing.setDefaultOrientationDetect(false);
    });

    const postReload = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const p = await app.projects.getProject(id);
      const pages = await app.db.pages.where({ projectId: id }).toArray();
      const progress = app.progress.compute(p!, pages);
      return {
        exists: !!p,
        built: progress.built,
        ratio: progress.ratio,
        hasSource: !!(await app.opfs.readBlob(p!.sourcePdfPath)),
        hasBuild: !!(p!.build && (await app.opfs.readBlob(p!.build.artifactPath))),
      };
    }, projectId);
    expect(postReload).toMatchObject({
      exists: true,
      built: true,
      ratio: 1,
      hasSource: true,
      hasBuild: true,
    });

    // Rewind to OCR and re-run the tail of the pipeline offline. Exercises
    // OCR → MRC → build with no network — uses mock OCR so no traineddata
    // fetch is required. Proves rewind cascades drop project.build and
    // subsequent runs regenerate it end-to-end.
    const rerunSummary = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const beforeBuildCalls = window.__pdfBuildCallCount ?? 0;
      const beforeRenderCalls = window.__pdfRenderCallCount ?? 0;
      await app.rewind.toStage(id, "ocr");
      const afterRewind = (await app.projects.getProject(id))!;
      const buildClearedByRewind = !afterRewind.build;
      await app.pipeline.runFromStage(afterRewind, "ocr");
      return {
        buildClearedByRewind,
        buildCallsDelta: (window.__pdfBuildCallCount ?? 0) - beforeBuildCalls,
        renderCallsDelta: (window.__pdfRenderCallCount ?? 0) - beforeRenderCalls,
      };
    }, projectId);
    // rewind(ocr) cascades through build → project.build clears.
    expect(rerunSummary.buildClearedByRewind).toBe(true);
    // Build ran at least once; render did not (its artifacts were cached).
    expect(rerunSummary.buildCallsDelta).toBeGreaterThan(0);
    expect(rerunSummary.renderCallsDelta).toBe(0);

    // Finally, pull the built PDF bytes back out and verify we can read
    // them offline — simulates the user clicking Download.
    const exported = await page.evaluate(async (id) => {
      const app = window.__pdfApp!;
      const blob = await app.build.readBuildOutput(id);
      if (!blob) return null;
      const first = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
      const bytes = await blob.arrayBuffer();
      const pageCount = await app.render.getPageCount(bytes);
      return {
        sizeBytes: blob.size,
        header: Array.from(first)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
        pageCount,
      };
    }, projectId);
    expect(exported).not.toBeNull();
    expect(exported!.sizeBytes).toBeGreaterThan(1000);
    expect(exported!.header).toBe("255044462d"); // %PDF-
    expect(exported!.pageCount).toBe(3);

    await context.setOffline(false);
  });
});
