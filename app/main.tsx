import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { registerServiceWorker } from "./lib/cache/register-sw";
import { installTestHarness } from "./lib/testing/harness";
import "./styles.css";

const dummyWasmUrl = `${import.meta.env.BASE_URL}wasm/dummy.wasm`;

const router = createRouter({
  routeTree,
  basepath: import.meta.env.BASE_URL,
  defaultPreload: "intent",
  context: { dummyWasmUrl },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element missing");

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

void registerServiceWorker();
installTestHarness();

// Prefetch the dummy WASM so the SW caches it on first load.
void fetch(dummyWasmUrl);
