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
    { timeout: 20_000 },
  );
}

test.describe("step 2 — render worker", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
  });

  test("load-example streams thumbnails into the page grid", async ({ page }) => {
    await page.getByTestId("load-example").click();

    const firstThumb = page.getByTestId("page-thumb-0");
    await expect(firstThumb).toBeVisible({ timeout: 20_000 });

    const secondThumb = page.getByTestId("page-thumb-1");
    await expect(secondThumb).toBeVisible({ timeout: 20_000 });

    await expect(page.getByTestId("page-card-2")).toHaveAttribute(
      "data-page-status",
      "done",
      { timeout: 20_000 },
    );

    const projectMeta = await page.getByTestId("project-meta").textContent();
    expect(projectMeta).toContain("3 pages");
  });

  test("cached render: re-running the pipeline never re-invokes mupdf", async ({ page }) => {
    const baselineCount = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = await app.example.load();
      const project = await app.projects.createProjectFromBytes("cache-check", bytes);
      await app.render.ensurePageRows(project);
      await app.render.runRenderPipeline((await app.projects.getProject(project.id))!);
      const before = window.__pdfRenderCallCount ?? 0;
      // re-run with cached artifacts present: should short-circuit every page.
      await app.render.runRenderPipeline((await app.projects.getProject(project.id))!);
      return { before, after: window.__pdfRenderCallCount ?? 0 };
    });
    expect(baselineCount.after).toBe(baselineCount.before);
  });

  test("abort during render leaves no render artifact for pending pages", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = await app.example.load();
      const project = await app.projects.createProjectFromBytes("abort-check", bytes);
      await app.render.ensurePageRows(project);
      const controller = new AbortController();
      controller.abort(); // abort before any page gets processed
      const fresh = (await app.projects.getProject(project.id))!;
      await app.render.runRenderPipeline(fresh, { signal: controller.signal });
      const pages = await app.db.pages.where({ projectId: project.id }).toArray();
      return pages.map((p) => ({ index: p.index, hasRender: !!p.status.render }));
    });
    expect(result.length).toBe(3);
    for (const row of result) expect(row.hasRender).toBe(false);
  });

  test("rendered PNG artifact is written to OPFS and is a valid PNG", async ({ page }) => {
    const probe = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = await app.example.load();
      const project = await app.projects.createProjectFromBytes("opfs-check", bytes);
      await app.render.ensurePageRows(project);
      await app.render.runRenderPipeline((await app.projects.getProject(project.id))!);
      const pageRow = await app.db.pages.get(`${project.id}:0`);
      if (!pageRow?.status.render) return null;
      const blob = await app.opfs.readBlob(pageRow.status.render.artifactPath);
      if (!blob) return null;
      const first8 = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
      return {
        size: blob.size,
        header: Array.from(first8).map((b) => b.toString(16).padStart(2, "0")).join(""),
      };
    });
    expect(probe).not.toBeNull();
    expect(probe!.size).toBeGreaterThan(1000);
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    expect(probe!.header).toBe("89504e470d0a1a0a");
  });

  test("mupdf.wasm is served from SW cache on offline reload", async ({ page, context }) => {
    await waitForSwActive(page);
    // First render populates the SW runtime-cache with mupdf.wasm
    await page.getByTestId("load-example").click();
    await expect(page.getByTestId("page-thumb-0")).toBeVisible({ timeout: 20_000 });

    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const hits: string[] = [];
      for (const name of names) {
        const cache = await caches.open(name);
        const reqs = await cache.keys();
        for (const req of reqs) if (req.url.includes("mupdf")) hits.push(req.url);
      }
      return hits;
    });
    expect(cached.length).toBeGreaterThan(0);

    await context.setOffline(true);
    await page.reload();
    await waitForHarness(page);

    const offlineCount = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = await app.example.load();
      const count = await app.projects.listProjects();
      return { bytesLen: bytes.byteLength, existingProjects: count.length };
    });
    expect(offlineCount.bytesLen).toBeGreaterThan(0);
    expect(offlineCount.existingProjects).toBeGreaterThan(0);
    await context.setOffline(false);
  });
});
