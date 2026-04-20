import { Workbox } from "workbox-window";

export interface CacheStatus {
  supported: boolean;
  usageBytes: number;
  quotaBytes: number;
  cachedEntries: number;
  cacheNames: string[];
}

let _wb: Workbox | null = null;

export async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  if (import.meta.env.DEV) return;
  const base = import.meta.env.BASE_URL;
  const wb = new Workbox(`${base}sw.js`, { scope: base });
  await wb.register();
  _wb = wb;
}

export async function unregisterServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((r) => r.unregister()));
  _wb = null;
}

export async function getCacheStatus(): Promise<CacheStatus> {
  const supported = "caches" in self && !!navigator.storage?.estimate;
  if (!supported) {
    return { supported: false, usageBytes: 0, quotaBytes: 0, cachedEntries: 0, cacheNames: [] };
  }
  const estimate = await navigator.storage.estimate();
  const cacheNames = await caches.keys();
  let cachedEntries = 0;
  for (const name of cacheNames) {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    cachedEntries += keys.length;
  }
  return {
    supported: true,
    usageBytes: estimate.usage ?? 0,
    quotaBytes: estimate.quota ?? 0,
    cachedEntries,
    cacheNames,
  };
}

export async function purgeCaches(): Promise<void> {
  if (!("caches" in self)) return;
  const names = await caches.keys();
  await Promise.all(names.map((n) => caches.delete(n)));
}

export function hasWorkbox(): boolean {
  return _wb !== null;
}
