import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { AssetsPill } from "~/components/assets-pill";

export interface RouterContext {
  dummyWasmUrl: string;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-full">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3 text-sm font-medium">
        <span data-testid="app-title">pdf — client-side OCR</span>
        <AssetsPill />
      </header>
      <main className="mx-auto max-w-5xl p-6">
        <Outlet />
      </main>
    </div>
  );
}
