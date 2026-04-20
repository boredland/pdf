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

test.describe("step 1 — storage, artifact model, service worker", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForHarness(page);
  });

  test("10MB OPFS round-trip survives reload, Dexie row persists", async ({ page }) => {
    await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const bytes = new Uint8Array(10 * 1024 * 1024);
      for (let i = 0; i < bytes.length; i += 4096) bytes[i] = (i / 4096) & 0xff;
      await app.opfs.writeFile("roundtrip/10mb.bin", bytes);
      await app.db.projects.put({
        id: "p-roundtrip",
        name: "round-trip",
        createdAt: Date.now(),
        sourcePdfPath: "roundtrip/10mb.bin",
        pageCount: 0,
        settings: app.artifacts.DEFAULT_SETTINGS,
      });
    });

    await page.reload();
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const blob = await app.opfs.readBlob("roundtrip/10mb.bin");
      const project = await app.db.projects.get("p-roundtrip");
      const sampleIndex = 4096 * 7;
      const buf = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
      return {
        blobSize: blob?.size ?? null,
        sample: buf ? buf[sampleIndex] : null,
        projectName: project?.name ?? null,
      };
    });

    expect(result.blobSize).toBe(10 * 1024 * 1024);
    expect(result.sample).toBe(7);
    expect(result.projectName).toBe("round-trip");
  });

  test("AES-GCM key wrap/unwrap across reload", async ({ page }) => {
    await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const wrapped = await app.keys.wrapSecret("super-secret-api-key", "pass-phrase-123");
      await app.db.apiKeys.put({
        providerId: "test-provider",
        ciphertext: wrapped.ciphertext,
        iv: wrapped.iv,
        salt: wrapped.salt,
        createdAt: Date.now(),
      });
    });

    await page.reload();
    await waitForHarness(page);

    const outcomes = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const stored = await app.db.apiKeys.get("test-provider");
      if (!stored) throw new Error("missing stored key");
      const good = await app.keys.unwrapSecret(stored, "pass-phrase-123");
      let badMessage: string | null = null;
      try {
        await app.keys.unwrapSecret(stored, "wrong");
      } catch (err) {
        badMessage = (err as Error).name ?? "error";
      }
      return { good, badMessage };
    });

    expect(outcomes.good).toBe("super-secret-api-key");
    expect(outcomes.badMessage).toBeTruthy();
  });

  test("settings hash stabilises and differs by stage", async ({ page }) => {
    const hashes = await page.evaluate(async () => {
      const app = window.__pdfApp!;
      const a = await app.artifacts.settingsHash(app.artifacts.DEFAULT_SETTINGS, "render");
      const b = await app.artifacts.settingsHash(app.artifacts.DEFAULT_SETTINGS, "render");
      const c = await app.artifacts.settingsHash(app.artifacts.DEFAULT_SETTINGS, "preprocess");
      const tweaked = {
        ...app.artifacts.DEFAULT_SETTINGS,
        preprocess: { ...app.artifacts.DEFAULT_SETTINGS.preprocess, deskew: false },
      };
      const d = await app.artifacts.settingsHash(tweaked, "preprocess");
      const e = await app.artifacts.settingsHash(tweaked, "ocr");
      return { a, b, c, d, e };
    });

    expect(hashes.a).toBe(hashes.b);
    expect(hashes.a).not.toBe(hashes.c);
    expect(hashes.c).not.toBe(hashes.d);
    expect(hashes.d).not.toBe(hashes.e);
  });

  test("service worker registers, precaches WASM, app shell boots offline", async ({
    page,
    context,
  }) => {
    await waitForSwActive(page);

    const precacheStatus = await page.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 500));
      const names = await caches.keys();
      const items: Record<string, number> = {};
      for (const name of names) {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        items[name] = keys.length;
      }
      return { names, items };
    });

    expect(precacheStatus.names.length).toBeGreaterThan(0);
    const totalEntries = Object.values(precacheStatus.items).reduce((a, b) => a + b, 0);
    expect(totalEntries).toBeGreaterThan(0);

    await context.setOffline(true);
    await page.reload();
    await waitForHarness(page);
    await expect(page.getByTestId("home-heading")).toBeVisible();

    const offlineWasmFetch = await page.evaluate(async () => {
      const probeEl = document.querySelector<HTMLElement>("[data-testid='dummy-wasm-url']");
      const text = probeEl?.textContent ?? "";
      const match = text.match(/precache-probe:\s*(\S+)/);
      if (!match) return { ok: false, status: "no-url" };
      const res = await fetch(match[1]!);
      return { ok: res.ok, status: `${res.status}` };
    });
    expect(offlineWasmFetch.ok).toBeTruthy();

    await context.setOffline(false);
  });

  test("assets pill opens, shows cache entries, purge clears them", async ({ page }) => {
    await waitForSwActive(page);
    const pill = page.getByTestId("assets-pill");
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(page.getByTestId("assets-pane")).toBeVisible();

    await expect
      .poll(
        async () =>
          Number.parseInt(
            (await page.getByTestId("assets-entries").textContent()) ?? "0",
            10,
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    await page.getByTestId("assets-purge").click();
    await expect
      .poll(async () =>
        Number.parseInt(
          (await page.getByTestId("assets-entries").textContent()) ?? "0",
          10,
        ),
      )
      .toBe(0);
  });
});
