import {
  parseModelSecret,
  pilotLauncher,
  pilotRunModel,
  pilotRuntimeForBot,
  resolvePrimaryDmRuntime,
  resolvePrimaryGroupRuntime,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { RouterDeps } from "../router.js";

async function usableClaudeKey(
  prisma: RouterDeps["prisma"],
  secrets: RouterDeps["secrets"],
  userId: string,
  id: string,
): Promise<boolean> {
  const row = await prisma.secret.findFirst({
    where: { id, userId, spaceId: null, kind: "model" },
    select: { ciphertext: true },
  });
  if (!row) return false;
  try {
    const secret = parseModelSecret(await secrets.load(row.ciphertext, id));
    return (
      secret.kind === "api_key" &&
      !!secret.key &&
      !secret.accountId &&
      !secret.gatewayId &&
      !secret.projectId &&
      !secret.region &&
      !secret.zeroDataRetention
    );
  } catch {
    // Do not expose the secret or provider error. Clearing the preference remains possible.
    return false;
  }
}

export async function primaryRuntimeSettings(
  { prisma, secrets }: Pick<RouterDeps, "prisma" | "secrets">,
  actor: Actor,
  botId: string,
) {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    select: {
      id: true,
      primaryRuntimePreference: true,
      primaryRuntimeRevision: true,
      modelProvider: true,
      modelId: true,
      modelCredentialId: true,
    },
  });
  if (!bot) throw new ClientError("NOT_FOUND", "Bot settings not found.");
  const { modelProvider, modelId, modelCredentialId } = bot;
  const connection =
    modelCredentialId && modelProvider
      ? await prisma.userModelCredential.findFirst({
          where: { id: modelCredentialId, provider: modelProvider, userId: actor.userId },
          select: { label: true, secretId: true },
        })
      : null;
  const canSelectClaude =
    pilotRuntimeForBot(botId) === "claude-agent" &&
    Boolean(
      pilotLauncher() &&
        connection &&
        pilotRunModel("claude-agent", bot) &&
        (await usableClaudeKey(prisma, secrets, actor.userId, connection.secretId)),
    );
  const runtime = (selection: ReturnType<typeof resolvePrimaryDmRuntime>) =>
    selection.kind === "default"
      ? ("pi" as const)
      : selection.kind === "native" && canSelectClaude
        ? ("claude-agent" as const)
        : ("unavailable" as const);
  return {
    preference: bot.primaryRuntimePreference,
    revision: bot.primaryRuntimeRevision,
    direct: runtime(resolvePrimaryDmRuntime(bot)),
    group: runtime(resolvePrimaryGroupRuntime(bot)),
    canSelectClaude,
    model: { modelProvider, modelId, modelCredentialId },
    connectionLabel: connection?.label ?? null,
  };
}
