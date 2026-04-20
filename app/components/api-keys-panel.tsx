import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getDb } from "~/lib/storage/db";
import {
  forgetApiKey,
  hasSessionPassphrase,
  setSessionPassphrase,
  storeApiKey,
} from "~/lib/api-keys";
import { listProviders } from "~/lib/providers/registry";

export function ApiKeysPanel() {
  const rows = useLiveQuery(() => getDb().apiKeys.toArray(), []);
  const [passphrase, setPassphrase] = useState("");
  const [providerId, setProviderId] = useState(
    listProviders().find((p) => p.kind === "hosted")?.id ?? "",
  );
  const [keyValue, setKeyValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(hasSessionPassphrase());

  const hostedProviders = listProviders().filter((p) => p.kind === "hosted");
  if (hostedProviders.length === 0) return null;

  async function onUnlock() {
    if (!passphrase) return;
    setSessionPassphrase(passphrase);
    setUnlocked(true);
    setError(null);
  }

  async function onSave() {
    try {
      if (!passphrase) {
        setError("enter a passphrase first");
        return;
      }
      if (!providerId || !keyValue) {
        setError("provider and key are required");
        return;
      }
      setSessionPassphrase(passphrase);
      setUnlocked(true);
      await storeApiKey(providerId, keyValue, passphrase);
      setKeyValue("");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section
      data-testid="api-keys-panel"
      className="space-y-3 rounded-md border border-slate-800 bg-slate-900/60 p-4 text-sm"
    >
      <header className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-100">Hosted provider keys</h3>
        <span
          className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-200"
          data-testid="api-keys-warning"
        >
          browser-stored · exposed to extensions/XSS
        </span>
      </header>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">Session passphrase</span>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            data-testid="api-keys-passphrase"
            className="rounded border border-slate-700 bg-slate-800 px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">Provider</span>
          <select
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            data-testid="api-keys-provider"
            className="rounded border border-slate-700 bg-slate-800 px-2 py-1"
          >
            {hostedProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-xs text-slate-400">API key</span>
          <input
            type="password"
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            data-testid="api-keys-value"
            className="rounded border border-slate-700 bg-slate-800 px-2 py-1"
          />
        </label>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void onUnlock()}
          data-testid="api-keys-unlock"
          className="rounded border border-slate-700 px-3 py-1 text-slate-300 hover:bg-slate-800"
        >
          Unlock session
        </button>
        <button
          type="button"
          onClick={() => void onSave()}
          data-testid="api-keys-save"
          className="rounded bg-sky-500/20 px-3 py-1 text-sky-200 hover:bg-sky-500/30"
        >
          Save key
        </button>
      </div>
      {unlocked && (
        <p className="text-xs text-emerald-300" data-testid="api-keys-unlocked">
          Session unlocked
        </p>
      )}
      {error && (
        <p className="text-xs text-red-300" data-testid="api-keys-error">
          {error}
        </p>
      )}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-slate-800 text-xs" data-testid="api-keys-list">
          {rows.map((row) => (
            <li key={row.providerId} className="flex items-center justify-between py-1">
              <span className="font-mono">{row.providerId}</span>
              <button
                type="button"
                onClick={() => void forgetApiKey(row.providerId)}
                data-testid={`api-keys-forget-${row.providerId}`}
                className="text-slate-400 hover:text-red-300"
              >
                forget
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
