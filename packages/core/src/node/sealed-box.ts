import type { KeyObject } from "node:crypto";
import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const INFO = Buffer.from("rakazo sealed box v1");
const TAG_BYTES = 16;
/** An X25519 public key as unpadded base64url: 32 bytes. */
export const SEALED_BOX_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;

/**
 * A key pair whose private half never leaves this process: anyone may seal a value to its public
 * key, and only this process opens it. A restart loses the key, and with it anything sealed to it.
 */
export interface SealedBoxKey {
  publicKey: string;
  /** The plaintext, or undefined when `sealed` was not sealed to this key or was altered. */
  open(sealed: string): string | undefined;
}

function rawPublicKey(key: KeyObject): string {
  const x = key.export({ format: "jwk" }).x;
  if (!x) throw new Error("X25519 key has no public part");
  return x;
}

function importPublicKey(raw: string): KeyObject {
  if (!SEALED_BOX_PUBLIC_KEY.test(raw)) throw new Error("Not an X25519 public key");
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw }, format: "jwk" });
}

function derive(shared: Buffer, ephemeral: string, recipient: string): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, `${ephemeral}.${recipient}`, INFO, 32));
}

export function createSealedBoxKey(): SealedBoxKey {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const recipient = rawPublicKey(publicKey);
  return {
    publicKey: recipient,
    open(sealed) {
      const [ephemeral, iv, body, tag, ...rest] = sealed.split(".");
      if (!ephemeral || !iv || !body || !tag || rest.length > 0) return undefined;
      try {
        const shared = diffieHellman({ privateKey, publicKey: importPublicKey(ephemeral) });
        const authTag = Buffer.from(tag, "base64url");
        // Only a full tag: a shortened one would make a forged box far easier to pass.
        if (authTag.length !== TAG_BYTES) return undefined;
        const decipher = createDecipheriv(
          "aes-256-gcm",
          derive(shared, ephemeral, recipient),
          Buffer.from(iv, "base64url"),
          { authTagLength: TAG_BYTES },
        );
        decipher.setAuthTag(authTag);
        return Buffer.concat([
          decipher.update(Buffer.from(body, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        return undefined;
      }
    },
  };
}

/** Seals `plaintext` so only the holder of `publicKey`'s private half can read it. */
export function sealTo(publicKey: string, plaintext: string): string {
  const recipient = importPublicKey(publicKey);
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralRaw = rawPublicKey(ephemeral.publicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive(shared, ephemeralRaw, publicKey), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    ephemeralRaw,
    iv.toString("base64url"),
    body.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}
