import { createFileRoute } from "@tanstack/react-router";
import { ProjectView } from "~/components/project-view";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const { dummyWasmUrl } = Route.useRouteContext();
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight" data-testid="home-heading">
          Client-side OCR for PDFs
        </h1>
        <p className="max-w-prose text-slate-400">
          Drop a PDF or load the bundled example. Rendering happens in a web worker; thumbnails
          stream in as each page is ready. Everything stays in your browser.
        </p>
      </header>
      <ProjectView />
      <p className="text-xs text-slate-600" data-testid="dummy-wasm-url">
        precache-probe: {dummyWasmUrl}
      </p>
    </div>
  );
}
