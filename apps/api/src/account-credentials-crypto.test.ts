import type { AccountExportCredentials } from "@rakazo/contracts";
import { AccountExportEncryptedCredentialsSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  decryptBackupCredentials,
  encryptBackupCredentials,
} from "./account-credentials-crypto.js";

const userId = "user-1";
const password = Buffer.from("correct horse battery staple", "utf8");
const wrongPassword = Buffer.from("correct horse battery stapler", "utf8");

const credentials: AccountExportCredentials = {
  version: 1,
  model: [{ provider: "acme", label: "Acme", supportsImages: false, plaintext: "sk-test-123" }],
  voice: [{ provider: "voice-co", plaintext: "voice-key" }],
  connections: [],
  mcp: [],
  vault: [
    {
      spaceId: null,
      name: "login",
      title: "",
      note: "",
      origin: "https://example.test",
      auth: { type: "login" },
      plaintext: "user:pass",
    },
  ],
  botSecrets: [],
};

async function sealed() {
  return encryptBackupCredentials({ userId, password, credentials });
}

describe("backup credentials encryption", () => {
  it("round-trips through the encrypted section", async () => {
    const file = await sealed();
    expect(
      await decryptBackupCredentials({
        userId,
        password,
        encrypted: JSON.parse(file.toString("utf8")),
      }),
    ).toEqual(credentials);
  });

  it("never puts the password or a plaintext value in the file", async () => {
    const file = await sealed();
    const text = file.toString("utf8");
    expect(text).not.toContain("correct horse battery staple");
    expect(text).not.toContain("sk-test-123");
    expect(text).not.toContain("voice-key");
    expect(text).not.toContain("user:pass");
    // The file is only salt, KDF parameters, nonce and ciphertext.
    expect(Object.keys(JSON.parse(text)).sort()).toEqual([
      "algorithm",
      "ciphertext",
      "kdf",
      "nonce",
      "tag",
    ]);
  });

  it("refuses a wrong password", async () => {
    const file = await sealed();
    await expect(
      decryptBackupCredentials({
        userId,
        password: wrongPassword,
        encrypted: JSON.parse(file.toString("utf8")),
      }),
    ).rejects.toThrow("backup password is incorrect");
  });

  it("refuses a tampered ciphertext", async () => {
    const file = JSON.parse((await sealed()).toString("utf8")) as Record<string, unknown>;
    const ciphertext = Buffer.from(file.ciphertext as string, "base64");
    ciphertext[0] = ciphertext[0]! ^ 1;
    file.ciphertext = ciphertext.toString("base64");
    await expect(decryptBackupCredentials({ userId, password, encrypted: file })).rejects.toThrow(
      "backup password is incorrect",
    );
  });

  it("refuses another account's section", async () => {
    const file = await sealed();
    await expect(
      decryptBackupCredentials({
        userId: "user-2",
        password,
        encrypted: JSON.parse(file.toString("utf8")),
      }),
    ).rejects.toThrow("backup password is incorrect");
  });

  it("refuses hostile KDF parameters before deriving", async () => {
    const file = JSON.parse((await sealed()).toString("utf8")) as Record<string, unknown>;
    (file.kdf as Record<string, unknown>).n = 2 ** 30;
    await expect(decryptBackupCredentials({ userId, password, encrypted: file })).rejects.toThrow(
      "backup password is incorrect",
    );
    expect(AccountExportEncryptedCredentialsSchema.safeParse(file).success).toBe(false);
  });
});
