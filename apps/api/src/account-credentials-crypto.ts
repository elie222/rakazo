import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
} from "node:crypto";
import type { AccountExportCredentials } from "@rakazo/contracts";
import {
  ACCOUNT_EXPORT_BACKUP_KDF,
  AccountExportCredentialsSchema,
  AccountExportEncryptedCredentialsSchema,
} from "@rakazo/contracts";

const ALGORITHM = "aes-256-gcm";

/** The section is present but the backup password cannot open it. No detail leaks why. */
export class BackupCredentialsError extends Error {
  constructor() {
    super("The backup password is incorrect or the credentials section is damaged.");
    this.name = "BackupCredentialsError";
  }
}

/** Zero a buffer that held a password or a derived key. Strings cannot be zeroed. */
export function zeroBuffer(buffer: Buffer): void {
  buffer.fill(0);
}

function deriveKey(password: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      ACCOUNT_EXPORT_BACKUP_KDF.keyLength,
      {
        N: ACCOUNT_EXPORT_BACKUP_KDF.n,
        r: ACCOUNT_EXPORT_BACKUP_KDF.r,
        p: ACCOUNT_EXPORT_BACKUP_KDF.p,
        // The derivation itself needs 128 * N * r bytes; twice that leaves headroom,
        // like the account-password derivation does.
        maxmem: 128 * ACCOUNT_EXPORT_BACKUP_KDF.n * ACCOUNT_EXPORT_BACKUP_KDF.r * 2,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/**
 * Seals the decrypted credentials for the archive. The returned bytes are the whole
 * `credentials.enc.json` entry: salt, KDF parameters, nonce and ciphertext only — the backup
 * password and the derived key never enter it. The AAD binds the section to this account.
 */
export async function encryptBackupCredentials(input: {
  userId: string;
  password: Buffer;
  credentials: AccountExportCredentials;
}): Promise<Buffer> {
  const salt = randomBytes(ACCOUNT_EXPORT_BACKUP_KDF.saltBytes);
  const nonce = randomBytes(ACCOUNT_EXPORT_BACKUP_KDF.nonceBytes);
  const key = await deriveKey(input.password, salt);
  try {
    const cipher = createCipheriv(ALGORITHM, key, nonce);
    cipher.setAAD(Buffer.from(input.userId, "utf8"));
    const plaintext = Buffer.from(JSON.stringify(input.credentials), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.from(
      JSON.stringify({
        algorithm: ALGORITHM,
        kdf: {
          algorithm: ACCOUNT_EXPORT_BACKUP_KDF.algorithm,
          n: ACCOUNT_EXPORT_BACKUP_KDF.n,
          r: ACCOUNT_EXPORT_BACKUP_KDF.r,
          p: ACCOUNT_EXPORT_BACKUP_KDF.p,
          keyLength: ACCOUNT_EXPORT_BACKUP_KDF.keyLength,
          salt: salt.toString("base64"),
        },
        nonce: nonce.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        tag: tag.toString("base64"),
      }),
      "utf8",
    );
  } finally {
    zeroBuffer(key);
  }
}

/**
 * Opens a `credentials.enc.json` entry. The schema pins the KDF parameters to their expected
 * values before any derivation runs, so a hostile archive cannot demand a ruinous cost.
 * Any failure — wrong password, tampered bytes, wrong account — is one generic error.
 */
export async function decryptBackupCredentials(input: {
  userId: string;
  password: Buffer;
  encrypted: unknown;
}): Promise<AccountExportCredentials> {
  const parsed = AccountExportEncryptedCredentialsSchema.safeParse(input.encrypted);
  if (!parsed.success) throw new BackupCredentialsError();
  const { kdf, nonce, ciphertext, tag } = parsed.data;
  const salt = Buffer.from(kdf.salt, "base64");
  const key = await deriveKey(input.password, salt);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(nonce, "base64"));
    decipher.setAAD(Buffer.from(input.userId, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    let json: unknown;
    try {
      json = JSON.parse(plaintext);
    } catch {
      throw new BackupCredentialsError();
    }
    const credentials = AccountExportCredentialsSchema.safeParse(json);
    if (!credentials.success) throw new BackupCredentialsError();
    return credentials.data;
  } catch (error) {
    if (error instanceof BackupCredentialsError) throw error;
    throw new BackupCredentialsError();
  } finally {
    zeroBuffer(key);
  }
}
