import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const BASE_PATH = process.env.VITE_BASE_PATH ?? "/";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.BASE_URL ?? `http://127.0.0.1:${PORT}${BASE_PATH}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: `bun run build && bun run preview --port ${PORT} --strictPort --host 127.0.0.1`,
        url: `http://127.0.0.1:${PORT}${BASE_PATH}`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
