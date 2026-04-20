import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const { dummyWasmUrl } = Route.useRouteContext();
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight" data-testid="home-heading">
        Client-side OCR for PDFs
      </h1>
      <p className="max-w-prose text-slate-400">
        This shell is running. Drop a PDF (coming in step 2) or load the bundled NARA example.
        Everything runs in your browser.
      </p>
      <div
        data-testid="home-placeholder"
        className="rounded-lg border border-dashed border-slate-700 p-12 text-center text-slate-500"
      >
        Upload + render coming in step 2.
      </div>
      <p className="text-xs text-slate-600" data-testid="dummy-wasm-url">
        precache-probe: {dummyWasmUrl}
      </p>
    </div>
  );
}
