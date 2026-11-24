import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const AES_GCM_NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const AES_GCM_OVERHEAD_BYTES = AES_GCM_NONCE_BYTES + TAG_BYTES;

/** Seal a payload as a 96-bit nonce, 128-bit tag and ciphertext, in that order. */
export function sealAesGcm(
  plaintext: Uint8Array,
  key: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array = randomBytes(AES_GCM_NONCE_BYTES),
): Buffer {
  // A caller that supplies a nonce must maintain nonce uniqueness for its key.
  if (nonce.byteLength !== AES_GCM_NONCE_BYTES) throw new Error("Invalid AES-GCM nonce length");
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

/** Return authenticated plaintext, or null for a truncated or unauthenticated envelope. */
export function openAesGcm(sealed: Uint8Array, key: Uint8Array, aad: Uint8Array): Buffer | null {
  if (sealed.byteLength < AES_GCM_OVERHEAD_BYTES) return null;
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, AES_GCM_NONCE_BYTES), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(AES_GCM_NONCE_BYTES, AES_GCM_OVERHEAD_BYTES));
  const plaintext = decipher.update(sealed.subarray(AES_GCM_OVERHEAD_BYTES));
  try {
    return Buffer.concat([plaintext, decipher.final()]);
  } catch {
    // The tag does not authenticate the supplied bytes, key and associated data.
    return null;
  }
}
