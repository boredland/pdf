/**
 * Curated list of Tesseract "fast" language models. Extended lists are
 * available at https://github.com/tesseract-ocr/tessdata_fast — this is a
 * reasonable v1 selection covering the common Latin, Cyrillic, Arabic,
 * CJK and Indic scripts. Add more by extending this array.
 */
export interface LanguageInfo {
  code: string;
  name: string;
  script?: string;
}

export const LANGUAGES: LanguageInfo[] = [
  { code: "eng", name: "English", script: "Latin" },
  { code: "deu", name: "German", script: "Latin" },
  { code: "deu_frak", name: "German (Fraktur)", script: "Latin / blackletter" },
  { code: "fra", name: "French", script: "Latin" },
  { code: "spa", name: "Spanish", script: "Latin" },
  { code: "ita", name: "Italian", script: "Latin" },
  { code: "por", name: "Portuguese", script: "Latin" },
  { code: "nld", name: "Dutch", script: "Latin" },
  { code: "pol", name: "Polish", script: "Latin" },
  { code: "lat", name: "Latin", script: "Latin" },
  { code: "rus", name: "Russian", script: "Cyrillic" },
  { code: "ukr", name: "Ukrainian", script: "Cyrillic" },
  { code: "ara", name: "Arabic", script: "Arabic" },
  { code: "heb", name: "Hebrew", script: "Hebrew" },
  { code: "ell", name: "Greek", script: "Greek" },
  { code: "chi_sim", name: "Chinese (Simplified)", script: "Han" },
  { code: "chi_tra", name: "Chinese (Traditional)", script: "Han" },
  { code: "jpn", name: "Japanese", script: "Han/Kana" },
  { code: "kor", name: "Korean", script: "Hangul" },
  { code: "hin", name: "Hindi", script: "Devanagari" },
  { code: "tur", name: "Turkish", script: "Latin" },
  { code: "vie", name: "Vietnamese", script: "Latin" },
];

// Full (not _fast) so we get niche models like deu_frak. The _fast variant
// drops blackletter and a few other specialised trainings.
export const CDN_LANG_BASE = "https://tessdata.projectnaptha.com/4.0.0/";
const BASE = import.meta.env.BASE_URL;
const LOCAL_LANG_PATH = `${BASE}tesseract/`;
export const LOCAL_PREBUILT_LANGS = new Set(["eng"]);

export function traineddataUrl(code: string): string {
  return LOCAL_PREBUILT_LANGS.has(code)
    ? `${LOCAL_LANG_PATH}${code}.traineddata`
    : `${CDN_LANG_BASE}${code}.traineddata.gz`;
}

/** Tesseract langPath used for a possibly-multi-language selection. */
export function langPathFor(language: string): { langPath: string; gzip: boolean } {
  const codes = language.split("+").filter(Boolean);
  const onlyLocal = codes.every((c) => LOCAL_PREBUILT_LANGS.has(c));
  if (onlyLocal) {
    return { langPath: LOCAL_LANG_PATH, gzip: false };
  }
  return { langPath: CDN_LANG_BASE, gzip: true };
}

export function parseLanguages(value: string): string[] {
  return value.split("+").map((s) => s.trim()).filter(Boolean);
}

export function joinLanguages(codes: string[]): string {
  const seen = new Set<string>();
  const ordered = codes.filter((c) => {
    if (!c) return false;
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  });
  return ordered.join("+");
}

export async function isLanguageCached(code: string): Promise<boolean> {
  if (LOCAL_PREBUILT_LANGS.has(code)) return true;
  if (typeof caches === "undefined") return false;
  const url = traineddataUrl(code);
  const names = await caches.keys();
  for (const name of names) {
    const cache = await caches.open(name);
    const match = await cache.match(url);
    if (match) return true;
  }
  return false;
}

export interface DownloadProgress {
  /** Bytes received so far. */
  loaded: number;
  /** Total bytes if the server sent Content-Length, otherwise null. */
  total: number | null;
  /** Fraction 0..1 or null if total is unknown. */
  ratio: number | null;
}

export interface DownloadOptions {
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
}

export async function downloadLanguage(
  code: string,
  options: DownloadOptions = {},
): Promise<void> {
  const url = traineddataUrl(code);
  // Kick a real fetch so the service worker's runtime cache picks it up.
  const res = await fetch(url, { cache: "reload", signal: options.signal });
  if (!res.ok) throw new Error(`failed to download ${code} (${res.status})`);
  const totalHeader = res.headers.get("Content-Length");
  const total = totalHeader ? Number.parseInt(totalHeader, 10) || null : null;

  const emit = (loaded: number) => {
    options.onProgress?.({
      loaded,
      total,
      ratio: total ? Math.min(1, loaded / total) : null,
    });
  };
  emit(0);

  if (!res.body) {
    // Server didn't give us a stream (e.g. some proxies in tests). Drain
    // via arrayBuffer and emit a single "done" event.
    const buf = await res.arrayBuffer();
    emit(buf.byteLength);
    return;
  }

  const reader = res.body.getReader();
  let loaded = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.byteLength;
      emit(loaded);
    }
  } finally {
    reader.releaseLock();
  }
  emit(loaded);
}
