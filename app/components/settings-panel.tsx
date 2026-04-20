import { useLiveQuery } from "dexie-react-hooks";
import type { Project } from "~/lib/storage/db";
import { getDb } from "~/lib/storage/db";
import { listProviders } from "~/lib/providers/registry";

export function SettingsPanel({
  project,
  disabled,
}: {
  project: Project;
  disabled?: boolean;
}) {
  async function update<K extends keyof Project["settings"]["preprocess"]>(
    key: K,
    value: Project["settings"]["preprocess"][K],
  ) {
    await getDb().projects.update(project.id, {
      settings: {
        ...project.settings,
        preprocess: { ...project.settings.preprocess, [key]: value },
      },
    });
  }

  async function updateOcrProvider(id: string) {
    await getDb().projects.update(project.id, {
      settings: { ...project.settings, ocr: { ...project.settings.ocr, providerId: id } },
    });
  }

  async function updateMrcPreset(preset: Project["settings"]["mrc"]["preset"]) {
    await getDb().projects.update(project.id, {
      settings: { ...project.settings, mrc: { preset } },
    });
  }

  const keyedProviderIds = useLiveQuery(
    async () => (await getDb().apiKeys.toArray()).map((row) => row.providerId),
    [],
  );
  // Hosted providers only appear in the dropdown once a key has been saved;
  // nothing is more confusing than a dropdown that lets you pick a provider
  // that can't actually run.
  const providers = listProviders().filter(
    (p) => p.kind !== "hosted" || (keyedProviderIds ?? []).includes(p.id),
  );

  return (
    <form
      className="grid gap-3 rounded-md border border-slate-800 bg-slate-900/60 p-4 text-sm sm:grid-cols-3"
      data-testid="settings-panel"
      onSubmit={(e) => e.preventDefault()}
    >
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          data-testid="settings-deskew"
          checked={project.settings.preprocess.deskew}
          disabled={disabled}
          onChange={(e) => void update("deskew", e.target.checked)}
        />
        <span>Deskew</span>
      </label>
      <label className="flex items-center gap-2">
        <span className="shrink-0">Binarizer</span>
        <select
          data-testid="settings-binarizer"
          className="min-w-0 rounded border border-slate-700 bg-slate-800 px-2 py-1"
          value={project.settings.preprocess.binarizer}
          disabled={disabled}
          onChange={(e) =>
            void update(
              "binarizer",
              e.target.value as Project["settings"]["preprocess"]["binarizer"],
            )
          }
        >
          <option value="sauvola">Sauvola (adaptive)</option>
          <option value="otsu">Otsu (global)</option>
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="shrink-0">Denoise radius</span>
        <input
          type="range"
          data-testid="settings-denoise"
          min={0}
          max={3}
          value={project.settings.preprocess.denoiseRadius}
          disabled={disabled}
          onChange={(e) => void update("denoiseRadius", Number.parseInt(e.target.value, 10))}
        />
        <span className="tabular-nums text-xs text-slate-400">
          {project.settings.preprocess.denoiseRadius}
        </span>
      </label>
      <label className="flex items-center gap-2 sm:col-span-3">
        <span className="shrink-0">OCR provider</span>
        <select
          data-testid="settings-ocr-provider"
          className="min-w-0 rounded border border-slate-700 bg-slate-800 px-2 py-1"
          value={project.settings.ocr.providerId}
          disabled={disabled}
          onChange={(e) => void updateOcrProvider(e.target.value)}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 sm:col-span-3">
        <span className="shrink-0">Output compression</span>
        <select
          data-testid="settings-mrc-preset"
          className="min-w-0 rounded border border-slate-700 bg-slate-800 px-2 py-1"
          value={project.settings.mrc.preset}
          disabled={disabled}
          onChange={(e) =>
            void updateMrcPreset(
              e.target.value as Project["settings"]["mrc"]["preset"],
            )
          }
        >
          <option value="lossless">Lossless</option>
          <option value="archival">Archival (JPEG 85%)</option>
          <option value="compact">Compact (JPEG 50% · half DPI)</option>
        </select>
      </label>
    </form>
  );
}
