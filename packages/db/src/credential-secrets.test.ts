import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { deleteUnreferencedCredentialSecret } from "./credential-secrets.js";

function credentialSecretPrisma(modelReferences: number, voiceReferences: number) {
  return {
    userModelCredential: { count: vi.fn().mockResolvedValue(modelReferences) },
    userVoiceCredential: { count: vi.fn().mockResolvedValue(voiceReferences) },
    secret: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
  } as unknown as PrismaClient;
}

describe("deleteUnreferencedCredentialSecret", () => {
  it("deletes a replaced secret after both credential kinds release it", async () => {
    const prisma = credentialSecretPrisma(0, 0);

    await deleteUnreferencedCredentialSecret(prisma, {
      credentialKind: "model",
      credentialId: "credential",
      secretId: "secret",
    });

    expect(prisma.userModelCredential.count).toHaveBeenCalledWith({
      where: { id: { not: "credential" }, secretId: "secret" },
    });
    expect(prisma.userVoiceCredential.count).toHaveBeenCalledWith({
      where: { secretId: "secret" },
    });
    expect(prisma.secret.deleteMany).toHaveBeenCalledWith({ where: { id: "secret" } });
  });

  it("keeps a secret while either credential kind still references it", async () => {
    const prisma = credentialSecretPrisma(0, 1);

    await deleteUnreferencedCredentialSecret(prisma, {
      credentialKind: "voice",
      credentialId: "credential",
      secretId: "secret",
    });

    expect(prisma.secret.deleteMany).not.toHaveBeenCalled();
  });
});
