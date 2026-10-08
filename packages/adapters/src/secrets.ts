import type { ScryptOptions } from "node:crypto";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  scryptSync,
} from "node:crypto";
import type {
  AdapterContext,
  SecretContext,
  SecretPutOptions,
  SecretRecord,
  SecretStore,
} from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { SecretChanges } from "./secret-changes.js";

const VERSION_PREFIX = "v2:";
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function legacyKeyFrom(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

const SCRYPT_OPTIONS: ScryptOptions = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function keyFrom(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, 32, SCRYPT_OPTIONS);
}

function keyFromAsync(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, 32, SCRYPT_OPTIONS, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

type SealedSecret = { salt: Buffer; iv: Buffer; tag: Buffer; enc: Buffer };

function parseSealed(ciphertext: string): SealedSecret {
  const buf = Buffer.from(ciphertext.slice(VERSION_PREFIX.length), "base64");
  if (buf.length < SALT_BYTES + IV_BYTES + TAG_BYTES) {
    throw new Error("Encrypted secret is malformed");
  }
  return {
    salt: buf.subarray(0, SALT_BYTES),
    iv: buf.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES),
    tag: buf.subarray(SALT_BYTES + IV_BYTES, SALT_BYTES + IV_BYTES + TAG_BYTES),
    enc: buf.subarray(SALT_BYTES + IV_BYTES + TAG_BYTES),
  };
}

function openSealed(sealed: SealedSecret, key: Buffer, recordId: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.iv);
  decipher.setAAD(Buffer.from(recordId));
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.enc), decipher.final()]).toString("utf8");
}

export class EncryptedSecretStore extends SecretChanges implements SecretStore {
  private warnedRemoteRef = false;

  constructor(private readonly encryptionKey: string) {
    super();
  }

  describe() {
    return {
      id: "app-encrypted",
      contractVersion: "1",
      adapterVersion: "0.2.0",
      capabilities: { rotate: true },
    };
  }

  async put(
    plaintext: string,
    context: AdapterContext,
    options: SecretPutOptions = {},
  ): Promise<SecretRecord> {
    context.signal.throwIfAborted();
    const recordId = options.recordId ?? randomBytes(12).toString("hex");
    const ref = this.seal(plaintext, recordId);
    this.changed(ref);
    return { id: recordId, ref, ciphertext: ref };
  }

  private seal(plaintext: string, recordId: string): string {
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", keyFrom(this.encryptionKey, salt), iv);
    cipher.setAAD(Buffer.from(recordId));
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION_PREFIX}${Buffer.concat([salt, iv, tag, enc]).toString("base64")}`;
  }

  private loadLegacy(ciphertext: string): string {
    // Ciphertexts written before v2 used a single SHA-256 key derivation and
    // no AAD. Keep them readable so an upgrade does not strand credentials;
    // every subsequent write uses the stronger versioned format above.
    const buf = Buffer.from(ciphertext, "base64");
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const enc = buf.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", legacyKeyFrom(this.encryptionKey), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  }

  /** Derive the v2 key in the threadpool so reads leave the event loop free. */
  async load(ciphertext: string, context: SecretContext): Promise<string> {
    const recordId = typeof context === "string" ? context : context.recordId;
    if (typeof context !== "string") context.signal?.throwIfAborted();
    if (ciphertext.startsWith("infisical:")) {
      const message =
        "Infisical secret references require SECRET_STORE=infisical; run the reverse migration before switching to encrypted storage (docs/infisical-secrets.md)";
      if (!this.warnedRemoteRef) {
        this.warnedRemoteRef = true;
        getLogger().warn(message);
      }
      throw new SecretStoreUnavailableError(undefined, message);
    }
    if (!ciphertext.startsWith(VERSION_PREFIX)) return this.loadLegacy(ciphertext);
    const sealed = parseSealed(ciphertext);
    const key = await keyFromAsync(this.encryptionKey, sealed.salt);
    if (typeof context !== "string") context.signal?.throwIfAborted();
    return openSealed(sealed, key, recordId);
  }

  async start(): Promise<void> {}
  async close(): Promise<void> {
    this.clearListeners();
  }
  async delete(ref: string, _context: SecretContext): Promise<void> {
    this.changed(ref);
  }

  redact(value: string): string {
    return value
      .replace(/sk-[a-zA-Z0-9-_]{8,}/g, "[redacted]")
      .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[redacted]");
  }
}
