import type { PrismaClient } from "./client.js";

type CredentialSecretClient = Pick<
  PrismaClient,
  "secret" | "userModelCredential" | "userVoiceCredential"
>;

export async function deleteUnreferencedCredentialSecret(
  prisma: CredentialSecretClient,
  input: {
    credentialKind: "model" | "voice";
    credentialId: string;
    secretId: string;
  },
): Promise<void> {
  const [modelReferences, voiceReferences] = await Promise.all([
    prisma.userModelCredential.count({
      where: {
        secretId: input.secretId,
        ...(input.credentialKind === "model" ? { id: { not: input.credentialId } } : {}),
      },
    }),
    prisma.userVoiceCredential.count({
      where: {
        secretId: input.secretId,
        ...(input.credentialKind === "voice" ? { id: { not: input.credentialId } } : {}),
      },
    }),
  ]);
  if (modelReferences + voiceReferences === 0) {
    await prisma.secret.deleteMany({ where: { id: input.secretId } });
  }
}
