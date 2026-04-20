import type { Project } from "~/lib/storage/db";
import { getDb } from "~/lib/storage/db";

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
    </form>
  );
}
