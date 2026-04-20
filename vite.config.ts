import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import path from "node:path";

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [
    TanStackRouterVite({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: "app/routes",
      generatedRouteTree: "app/routeTree.gen.ts",
    }),
    react(),
  ],
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "app"),
    },
  },
  server: {
    port: 5173,
  },
});
