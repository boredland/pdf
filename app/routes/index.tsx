import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight" data-testid="home-heading">
        Client-side OCR for PDFs
      </h1>
      <p className="text-slate-400 max-w-prose">
        This shell is step 0 of the delivery plan. Drop a PDF anywhere (soon), or load the bundled
        NARA example. Everything runs in your browser.
      </p>
      <div
        data-testid="home-placeholder"
        className="rounded-lg border border-dashed border-slate-700 p-12 text-center text-slate-500"
      >
        Upload + render coming in step 2.
      </div>
    </div>
  );
}
