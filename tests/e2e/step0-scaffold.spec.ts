import { expect, test } from "@playwright/test";

test.describe("step 0 — scaffold", () => {
  test("home loads with no console errors and SPA markers", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(err.message));

    const response = await page.goto("/");
    expect(response?.ok()).toBeTruthy();

    await expect(page.getByTestId("app-title")).toHaveText("pdf — client-side OCR");
    await expect(page.getByTestId("home-heading")).toBeVisible();

    // SPA shell: the initial HTML should not contain rendered React markup.
    // (Without SSR, the server-delivered #root is empty; React hydrates on the client.)
    const html = await response!.text();
    const rootMatch = html.match(/<div id="root">([\s\S]*?)<\/div>/);
    expect(rootMatch?.[1]?.trim() ?? "").toBe("");

    expect(consoleErrors).toEqual([]);
  });
});
