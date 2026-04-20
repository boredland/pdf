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

interface DownloadState {
  loaded: number;
  total: number | null;
  ratio: number | null;
}

export function LanguagesPanel({ project, disabled }: Props) {
  const [cacheState, setCacheState] = useState<Record<string, CacheState>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, DownloadState>>({});
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
    setProgress((prev) => ({ ...prev, [lang.code]: { loaded: 0, total: null, ratio: 0 } }));
    try {
      await downloadLanguage(lang.code, {
        onProgress: (p) => {
          setProgress((prev) => ({ ...prev, [lang.code]: p }));
        },
      });
      await refreshCacheState();
    } catch (err) {
      setError(`${lang.code}: ${(err as Error).message}`);
    } finally {
      setBusy(null);
      // Keep the final progress visible briefly so "100%" registers, then clear.
      window.setTimeout(() => {
        setProgress((prev) => {
          const next = { ...prev };
          delete next[lang.code];
          return next;
        });
      }, 600);
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
                <DownloadButton
                  lang={lang}
                  busy={isBusy}
                  progress={progress[lang.code]}
                  disabled={!!disabled}
                  onClick={() => void onDownload(lang)}
                  formatBytes={formatBytes}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DownloadButton(props: {
  lang: LanguageInfo;
  busy: boolean;
  progress?: DownloadState;
  disabled: boolean;
  onClick: () => void;
  formatBytes: (bytes: number) => string;
}) {
  const { lang, busy, progress, disabled, onClick, formatBytes } = props;

  // Progress bar modes:
  // - ratio known (Content-Length present) → filled bar from 0..100%
  // - ratio unknown but bytes flowing → show bytes downloaded, bar stays at 50%
  //   as an activity indicator
  const ratio = progress?.ratio ?? null;
  const loaded = progress?.loaded ?? 0;
  const indicator = busy && ratio === null && loaded > 0;

  let label: string;
  if (!busy) label = "download";
  else if (ratio !== null) label = `${Math.round(ratio * 100)}%`;
  else if (loaded > 0) label = formatBytes(loaded);
  else label = "starting…";

  const fillPercent = busy ? (ratio !== null ? ratio * 100 : indicator ? 50 : 10) : 0;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      data-testid={`lang-download-${lang.code}`}
      data-progress={
        busy ? (ratio !== null ? ratio.toFixed(3) : "indeterminate") : "idle"
      }
      aria-label={busy ? `Downloading ${lang.name}, ${label}` : `Download ${lang.name}`}
      className="relative min-w-[84px] overflow-hidden rounded border border-slate-700 bg-slate-800 text-[10px] text-slate-200 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-80"
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 bg-sky-500/40 ${
          indicator ? "animate-pulse" : ""
        } transition-[width] duration-150`}
        style={{ width: `${fillPercent}%` }}
      />
      <span className="relative block px-2 py-0.5 tabular-nums">{label}</span>
    </button>
  );
}
