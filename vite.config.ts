import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

const base = process.env.VITE_BASE_PATH ?? "/";

export default defineConfig({
  base,
  plugins: [
    TanStackRouterVite({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: "app/routes",
      generatedRouteTree: "app/routeTree.gen.ts",
    }),
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      filename: "sw.js",
      strategies: "generateSW",
      devOptions: { enabled: false },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,svg,wasm}", "examples/**/*.pdf"],
        maximumFileSizeToCacheInBytes: 32 * 1024 * 1024,
        navigateFallback: `${base}index.html`,
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            urlPattern: /\.traineddata(\.gz)?$/i,
            handler: "CacheFirst",
            options: {
              cacheName: "tesseract-langs",
              expiration: { maxEntries: 24 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\.wasm$/i,
            handler: "CacheFirst",
            options: {
              cacheName: "wasm-runtime",
              expiration: { maxEntries: 32 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: "pdf — client-side OCR",
        short_name: "pdf",
        description: "Fully client-side OCR for PDFs",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        start_url: base,
        scope: base,
        icons: [
          {
            src: "favicon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "app"),
    },
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["mupdf", "@techstark/opencv-js"],
  },
  build: {
    target: "es2022",
  },
  esbuild: {
    target: "es2022",
  },
  server: {
    port: 5173,
  },
});
