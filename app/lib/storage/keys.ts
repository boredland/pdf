const PBKDF2_ITERATIONS = 210_000;
const KEY_LENGTH_BITS = 256;
const IV_LENGTH_BYTES = 12;
const SALT_LENGTH_BYTES = 16;

async function deriveKey(passphrase: string, salt: BufferSource): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: KEY_LENGTH_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface WrappedSecret {
  ciphertext: ArrayBuffer;
  iv: ArrayBuffer;
  salt: ArrayBuffer;
}

export async function wrapSecret(plaintext: string, passphrase: string): Promise<WrappedSecret> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    ciphertext,
    iv: iv.buffer,
    salt: salt.buffer,
  };
}

export async function unwrapSecret(wrapped: WrappedSecret, passphrase: string): Promise<string> {
  const key = await deriveKey(passphrase, wrapped.salt);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: wrapped.iv },
    key,
    wrapped.ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}
