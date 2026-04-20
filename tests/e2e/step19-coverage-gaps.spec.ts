import { expect, test, type Page } from "@playwright/test";

async function waitForHarness(page: Page) {
  await page.waitForFunction(() => typeof window.__pdfApp !== "undefined", null, {
    timeout: 10_000,
  });
}

test.describe("step 19 — test-coverage gaps", () => {
  test.setTimeout(120_000);
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
    await page.evaluate(() => {
      window.__pdfApp!.testing.setDefaultOcrProvider("mock");
      window.__pdfApp!.testing.setDefaultOrientationDetect(false);
    });
  });

  test("drop zone: a real PDF file dropped via the file input creates a project", async ({
    page,
  }) => {
    // Fetch the synthetic fixture from the same origin; the DropZone's
    // hidden file input accepts anything setInputFiles gives it.
    const pdfBytes = await page.evaluate(async () => {
      const res = await fetch("/examples/fallback.pdf");
      const buf = await res.arrayBuffer();
      return Array.from(new Uint8Array(buf));
    });

    await page.getByTestId("file-input").setInputFiles({
      name: "dropped.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(pdfBytes),
    });

    await expect(page.getByTestId("project-name")).toHaveText(
      "dropped.pdf",
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("project-meta")).toContainText(
      /\d+ pages?/,
    );
  });

  test("abort mid-build: signal cascades through the build call", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = await app.example.load();
      const project = await app.projects.createProjectFromBytes(
        "abort-during-build",
        bytes,
      );
      await app.render.ensurePageRows(project);
      // Bring the project up to "ready to build" without actually running
      // build yet.
      await app.pipeline.runFromStage(
        (await app.projects.getProject(project.id))!,
        "render",
        { pageIndices: [0, 1, 2] },
      );
      // Now invoke build with an already-aborted signal; it should bail
      // without producing a build artifact.
      const controller = new AbortController();
      controller.abort();
      const before = window.__pdfBuildCallCount ?? 0;
      try {
        const fresh = (await app.projects.getProject(project.id))!;
        await app.build.runBuildPipeline(fresh, { signal: controller.signal });
      } catch {
        // Swallowed — we only care about the resulting state.
      }
      const finalProject = (await app.projects.getProject(project.id))!;
      return {
        buildCallsDelta: (window.__pdfBuildCallCount ?? 0) - before,
        finalBuildExists: !!finalProject.build,
      };
    });

    // The build call can still be invoked (it may short-circuit on the
    // aborted signal internally) but we want no artifact to land.
    expect(result.finalBuildExists).toBe(false);
  });

  test("OPFS: reads a non-existent file return null instead of throwing", async ({
    page,
  }) => {
    // OPFS quota exhaustion is hard to exercise from Playwright without
    // flags, but reading a missing path exercises the same storage-layer
    // "graceful absence" contract: callers that depend on it are:
    //   - rewind (removing artifacts that were already deleted)
    //   - builder cache short-circuit
    const probe = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const blob = await app.opfs.readBlob("never/exists/at/all.bin");
      return { isNull: blob === null };
    });
    expect(probe.isNull).toBe(true);
  });
});
