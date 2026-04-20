import { useEffect, useState } from "react";
import { getCacheStatus, purgeCaches, type CacheStatus } from "~/lib/cache/register-sw";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function AssetsPill() {
  const [status, setStatus] = useState<CacheStatus | null>(null);
  const [open, setOpen] = useState(false);

  async function refresh() {
    setStatus(await getCacheStatus());
  }

  useEffect(() => {
    refresh();
    const handle = window.setInterval(refresh, 5000);
    return () => window.clearInterval(handle);
  }, []);

  if (!status) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="assets-pill"
        className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-medium text-slate-300 hover:bg-slate-800"
      >
        {status.cachedEntries} cached · {formatBytes(status.usageBytes)}
      </button>
      {open && (
        <div
          data-testid="assets-pane"
          className="absolute right-0 z-10 mt-2 w-80 rounded-md border border-slate-700 bg-slate-900 p-3 text-xs shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="font-semibold text-slate-100">Asset cache</span>
            <button
              type="button"
              onClick={async () => {
                await purgeCaches();
                await refresh();
              }}
              className="text-slate-400 hover:text-slate-100"
              data-testid="assets-purge"
            >
              purge
            </button>
          </div>
          <dl className="space-y-1 text-slate-400">
            <div className="flex justify-between">
              <dt>Usage</dt>
              <dd data-testid="assets-usage">{formatBytes(status.usageBytes)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Quota</dt>
              <dd>{formatBytes(status.quotaBytes)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Entries</dt>
              <dd data-testid="assets-entries">{status.cachedEntries}</dd>
            </div>
            <div>
              <dt className="mb-1">Cache names</dt>
              <dd>
                <ul data-testid="assets-cache-names" className="space-y-0.5 font-mono text-[10px]">
                  {status.cacheNames.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
