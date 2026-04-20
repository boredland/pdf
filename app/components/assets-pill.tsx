import { useEffect, useState } from "react";
import {
  getCacheStatus,
  purgeCacheBucket,
  purgeCaches,
  type CacheStatus,
} from "~/lib/cache/register-sw";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

export function AssetsPill() {
  const [status, setStatus] = useState<CacheStatus | null>(null);
  const [open, setOpen] = useState(false);
  const online = useOnlineStatus();

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
        data-online={online ? "true" : "false"}
        className="flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-medium text-slate-300 hover:bg-slate-800"
        title={online ? "Online — fresh fetches allowed" : "Offline — cache only"}
      >
        <span
          data-testid="assets-online-indicator"
          className={`inline-block h-2 w-2 rounded-full ${
            online ? "bg-emerald-400" : "bg-amber-400"
          }`}
        />
        {status.cachedEntries} cached · {formatBytes(status.usageBytes)}
      </button>
      {open && (
        <div
          data-testid="assets-pane"
          className="absolute right-0 z-10 mt-2 w-96 rounded-md border border-slate-700 bg-slate-900 p-3 text-xs shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="font-semibold text-slate-100">Asset cache</span>
            <span
              data-testid="assets-online-label"
              className={online ? "text-emerald-400" : "text-amber-400"}
            >
              {online ? "online" : "offline"}
            </span>
          </div>
          <dl className="space-y-1 text-slate-400">
            <div className="flex justify-between">
              <dt>Usage</dt>
              <dd data-testid="assets-usage">
                {formatBytes(status.usageBytes)} /{" "}
                {formatBytes(status.quotaBytes)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt>Entries</dt>
              <dd data-testid="assets-entries">{status.cachedEntries}</dd>
            </div>
          </dl>
          {status.buckets.length > 0 && (
            <>
              <div className="mt-3 mb-1 font-semibold text-slate-200">
                Buckets
              </div>
              <ul
                data-testid="assets-cache-names"
                className="space-y-1 font-mono text-[10px]"
              >
                {status.buckets.map((bucket) => (
                  <li
                    key={bucket.name}
                    data-testid={`assets-bucket-${bucket.name}`}
                    className="flex items-center justify-between gap-2 rounded border border-slate-800 bg-slate-950/60 px-2 py-1"
                  >
                    <span className="truncate" title={bucket.name}>
                      {bucket.name}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">
                        {bucket.entries} entr
                        {bucket.entries === 1 ? "y" : "ies"}
                      </span>
                      <button
                        type="button"
                        data-testid={`assets-bucket-purge-${bucket.name}`}
                        className="rounded bg-slate-800 px-1.5 text-[10px] text-slate-300 hover:bg-slate-700"
                        onClick={async () => {
                          await purgeCacheBucket(bucket.name);
                          await refresh();
                        }}
                      >
                        purge
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={async () => {
                await purgeCaches();
                await refresh();
              }}
              className="rounded bg-red-500/20 px-2 py-1 text-red-200 hover:bg-red-500/30"
              data-testid="assets-purge"
            >
              Purge all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
