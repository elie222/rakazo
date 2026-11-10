import { describe, expect, it } from "vitest";
import {
  AccountExportCredentialsSchema,
  AccountExportEncryptedCredentialsSchema,
  AccountExportManifestSchema,
} from "./account-export.js";

const manifest = {
  format: "rakazo-account-export",
  exportedAt: "2026-10-01T00:00:00.000Z",
  user: { name: "Ada", email: "ada@example.com", timezone: "UTC" },
  spaces: [],
};

describe("account export manifest", () => {
  it("accepts versions 1 and 2", () => {
    expect(AccountExportManifestSchema.parse({ ...manifest, version: 1 }).version).toBe(1);
    expect(AccountExportManifestSchema.parse({ ...manifest, version: 2 }).version).toBe(2);
  });

  it("rejects version 3", () => {
    expect(AccountExportManifestSchema.safeParse({ ...manifest, version: 3 }).success).toBe(false);
  });
});

const encrypted = {
  algorithm: "aes-256-gcm",
  kdf: {
    algorithm: "scrypt",
    n: 32768,
    r: 8,
    p: 1,
    keyLength: 32,
    salt: Buffer.from("0123456789abcdef").toString("base64"),
  },
  nonce: Buffer.from("0123456789ab").toString("base64"),
  ciphertext: Buffer.from("ciphertext").toString("base64"),
  tag: Buffer.from("0123456789abcdef").toString("base64"),
};

describe("encrypted credentials section", () => {
  it("accepts the pinned KDF parameters", () => {
    expect(AccountExportEncryptedCredentialsSchema.parse(encrypted)).toEqual(encrypted);
  });

  it.each([
    ["a ruinous N", { ...encrypted, kdf: { ...encrypted.kdf, n: 2 ** 20 } }],
    ["a short salt", { ...encrypted, kdf: { ...encrypted.kdf, salt: "AAAA" } }],
    ["a short nonce", { ...encrypted, nonce: "AAAA" }],
    ["another algorithm", { ...encrypted, algorithm: "aes-256-cbc" }],
    ["another KDF", { ...encrypted, kdf: { ...encrypted.kdf, algorithm: "argon2" } }],
  ])("rejects %s", (_label, value) => {
    expect(AccountExportEncryptedCredentialsSchema.safeParse(value).success).toBe(false);
  });
});

describe("decrypted credentials section", () => {
  it("defaults every table to empty", () => {
    expect(AccountExportCredentialsSchema.parse({ version: 1 })).toEqual({
      version: 1,
      model: [],
      voice: [],
      connections: [],
      mcp: [],
      vault: [],
      botSecrets: [],
    });
  });

  it("rejects an oversized plaintext", () => {
    expect(
      AccountExportCredentialsSchema.safeParse({
        version: 1,
        model: [
          { provider: "x", label: "x", supportsImages: false, plaintext: "y".repeat(2 ** 20 + 1) },
        ],
      }).success,
    ).toBe(false);
  });
});
