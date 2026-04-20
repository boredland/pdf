import { getDb } from "~/lib/storage/db";
import { unwrapSecret, wrapSecret } from "~/lib/storage/keys";

let sessionPassphrase: string | null = null;
const decryptedCache = new Map<string, string>();

export function setSessionPassphrase(passphrase: string): void {
  sessionPassphrase = passphrase;
  decryptedCache.clear();
}

export function clearSessionPassphrase(): void {
  sessionPassphrase = null;
  decryptedCache.clear();
}

export function hasSessionPassphrase(): boolean {
  return sessionPassphrase !== null;
}

export async function hasApiKey(providerId: string): Promise<boolean> {
  const db = getDb();
  const row = await db.apiKeys.get(providerId);
  return !!row;
}

export async function storeApiKey(
  providerId: string,
  plaintext: string,
  passphrase?: string,
): Promise<void> {
  const phrase = passphrase ?? sessionPassphrase;
  if (!phrase) throw new Error("session passphrase required before storing keys");
  const wrapped = await wrapSecret(plaintext, phrase);
  await getDb().apiKeys.put({
    providerId,
    ciphertext: wrapped.ciphertext,
    iv: wrapped.iv,
    salt: wrapped.salt,
    createdAt: Date.now(),
  });
  decryptedCache.set(providerId, plaintext);
}

export async function getApiKey(providerId: string): Promise<string | null> {
  if (decryptedCache.has(providerId)) return decryptedCache.get(providerId) ?? null;
  if (!sessionPassphrase) return null;
  const row = await getDb().apiKeys.get(providerId);
  if (!row) return null;
  try {
    const plaintext = await unwrapSecret(
      { ciphertext: row.ciphertext, iv: row.iv, salt: row.salt },
      sessionPassphrase,
    );
    decryptedCache.set(providerId, plaintext);
    return plaintext;
  } catch {
    return null;
  }
}

export async function forgetApiKey(providerId: string): Promise<void> {
  await getDb().apiKeys.delete(providerId);
  decryptedCache.delete(providerId);
}
