import { useEffect, useState } from "react";
import {
  downloadLanguage,
  isLanguageCached,
  LANGUAGES,
  LOCAL_PREBUILT_LANGS,
  parseLanguages,
  joinLanguages,
  type LanguageInfo,
} from "~/lib/languages";
import type { Project } from "~/lib/storage/db";
import { getDb } from "~/lib/storage/db";

interface Props {
  project: Project;
  disabled?: boolean;
}

type CacheState = "checking" | "cached" | "missing";

export function LanguagesPanel({ project, disabled }: Props) {
  const [cacheState, setCacheState] = useState<Record<string, CacheState>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = parseLanguages(project.settings.ocr.language);
  const selectedSet = new Set(selected);

  async function refreshCacheState() {
    const entries = await Promise.all(
      LANGUAGES.map(async (lang) => {
        const cached = await isLanguageCached(lang.code);
        return [lang.code, cached ? "cached" : "missing"] as const;
      }),
    );
    setCacheState(Object.fromEntries(entries));
  }

  useEffect(() => {
    void refreshCacheState();
    const handle = window.setInterval(refreshCacheState, 5000);
    return () => window.clearInterval(handle);
  }, []);

  async function onDownload(lang: LanguageInfo) {
    setError(null);
    setBusy(lang.code);
    try {
      await downloadLanguage(lang.code);
      await refreshCacheState();
    } catch (err) {
      setError(`${lang.code}: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function toggleSelect(code: string, checked: boolean) {
    const next = checked
      ? joinLanguages([...selected, code])
      : joinLanguages(selected.filter((c) => c !== code));
    await getDb().projects.update(project.id, {
      settings: { ...project.settings, ocr: { ...project.settings.ocr, language: next || "eng" } },
    });
  }

  return (
    <section
      data-testid="languages-panel"
      className="space-y-3 rounded-md border border-slate-800 bg-slate-900/60 p-4 text-sm"
    >
      <header className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-100">OCR languages (Tesseract)</h3>
        <span className="text-[10px] uppercase tracking-wide text-slate-500">
          selected: {selected.length === 0 ? "—" : selected.join(" + ")}
        </span>
      </header>
      {error && (
        <p className="text-xs text-red-300" data-testid="languages-error">
          {error}
        </p>
      )}
      <ul
        className="grid grid-cols-1 gap-1.5 md:grid-cols-2"
        data-testid="languages-list"
      >
        {LANGUAGES.map((lang) => {
          const state = cacheState[lang.code] ?? "checking";
          const isCached = state === "cached" || LOCAL_PREBUILT_LANGS.has(lang.code);
          const isSelected = selectedSet.has(lang.code);
          const isBusy = busy === lang.code;
          return (
            <li
              key={lang.code}
              data-testid={`lang-row-${lang.code}`}
              data-cache-state={isCached ? "cached" : "missing"}
              className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950/40 px-2 py-1.5"
            >
              <input
                type="checkbox"
                checked={isSelected}
                disabled={disabled || !isCached}
                onChange={(e) => void toggleSelect(lang.code, e.target.checked)}
                data-testid={`lang-check-${lang.code}`}
                aria-label={`Use ${lang.name}`}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  <span className="font-medium text-slate-200">{lang.name}</span>
                  <span className="ml-2 font-mono text-[10px] text-slate-500">{lang.code}</span>
                </p>
                {lang.script && (
                  <p className="text-[10px] text-slate-500">{lang.script}</p>
                )}
              </div>
              {isCached ? (
                <span
                  className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-300"
                  data-testid={`lang-status-${lang.code}`}
                >
                  cached
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => void onDownload(lang)}
                  disabled={disabled || isBusy}
                  data-testid={`lang-download-${lang.code}`}
                  className="rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] text-slate-200 hover:bg-slate-700 disabled:opacity-60"
                >
                  {isBusy ? "downloading…" : "download"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
