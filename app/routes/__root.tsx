import { Outlet, createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-full">
      <header className="border-b border-slate-800 px-4 py-3 text-sm font-medium">
        <span data-testid="app-title">pdf — client-side OCR</span>
      </header>
      <main className="mx-auto max-w-5xl p-6">
        <Outlet />
      </main>
    </div>
  );
}
