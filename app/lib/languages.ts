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

export async function downloadLanguage(code: string): Promise<void> {
  const url = traineddataUrl(code);
  // Kick a real fetch so the service worker's runtime cache picks it up.
  const res = await fetch(url, { cache: "reload" });
  if (!res.ok) throw new Error(`failed to download ${code} (${res.status})`);
  // Drain the body so the fetch actually completes and SW commits the cache
  // write — some browsers short-circuit otherwise.
  await res.arrayBuffer();
}
