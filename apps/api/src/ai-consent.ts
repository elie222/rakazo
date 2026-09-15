import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
  aiRecipient,
  cloudAgentsEnabled,
  parseModelSecret,
  selectConfiguredModel,
  toStringRecord,
} from "@rakazo/adapters";
import type { Actor, AiConsentQuery, AiConsentStatus, AiRecipient } from "@rakazo/contracts";
import { AI_DISCLOSURE_VERSION, AI_PRIVACY_URL } from "@rakazo/contracts";
import {
  findDefaultModelCredential,
  findDefaultVoiceCredential,
  findModelCredential,
} from "@rakazo/db";
import type { RouterDeps } from "./router.js";
import { resolveThreadTarget } from "./thread-target.js";

export async function aiConsentStatus(
  deps: RouterDeps,
  actor: Actor,
  query: AiConsentQuery = {},
): Promise<AiConsentStatus> {
  const uses = query.uses ?? ["model", "memory", "voice"];
  const modelsEnabled = uses.includes("model") && deps.env.agentRuntime !== "scripted";
  const target =
    query.botId || query.groupId ? await resolveThreadTarget(deps.prisma, actor, query) : null;
  const botIds = target
    ? target.kind === "bot"
      ? [target.botId]
      : target.memberBotIds
    : undefined;
  const [preferences, defaultCredential, bots, voices, memory, settings, consents] =
    await Promise.all([
      modelsEnabled
        ? deps.prisma.spaceModelPreference.findMany({
            where: { userId: actor.userId, spaceId: actor.spaceId },
            include: { credential: true },
          })
        : [],
      modelsEnabled ? findDefaultModelCredential(deps.prisma, actor) : null,
      modelsEnabled
        ? deps.prisma.bot.findMany({
            where: {
              userId: actor.userId,
              spaceId: actor.spaceId,
              archivedAt: null,
              ...(botIds ? { id: { in: botIds } } : {}),
            },
            select: { modelProvider: true, modelId: true, thinkingLevel: true },
          })
        : [],
      uses.includes("voice")
        ? query.uses
          ? findDefaultVoiceCredential(deps.prisma, actor).then((credential) =>
              credential ? [{ credential }] : [],
            )
          : deps.prisma.spaceVoicePreference.findMany({
              where: { userId: actor.userId, spaceId: actor.spaceId },
              include: { credential: true },
            })
        : [],
      uses.includes("memory")
        ? deps.prisma.spaceMemoryConfig.findUnique({ where: { spaceId: actor.spaceId } })
        : null,
      modelsEnabled
        ? deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } })
        : null,
      deps.prisma.aiDataConsent.findMany({
        where: { userId: actor.userId, spaceId: actor.spaceId, version: AI_DISCLOSURE_VERSION },
      }),
    ]);
  const allowed = new Set(consents.map((row) => row.recipientKey));
  const recipients = new Map<string, AiRecipient>();
  const add = (recipient: ReturnType<typeof aiRecipient>) => {
    if (recipient)
      recipients.set(recipient.key, { ...recipient, allowed: allowed.has(recipient.key) });
  };
  if (modelsEnabled) {
    const deployment = deps.env.deploymentModelKey
      ? { provider: deps.env.defaultProvider, model: deps.env.defaultModel }
      : null;
    const selected = await Promise.all(
      (target ? bots : [null, ...bots]).map(async (bot) => {
        const overrideCredential =
          bot?.modelProvider && bot.modelId
            ? await findModelCredential(deps.prisma, actor, bot.modelProvider, bot.modelId)
            : null;
        return selectConfiguredModel({
          bot,
          overrideCredential,
          defaultCredential,
          settings,
          deployment,
        });
      }),
    );
    // Connected models remain reachable by helpers during a targeted bot run.
    for (const preference of preferences)
      selected.push({
        provider: preference.credential.provider,
        id: preference.modelId ?? "",
        credential: {
          ...preference.credential,
          isDefault: preference.isDefault,
          defaultModel: preference.modelId,
        },
        thinkingLevel: null,
      });
    if (deps.env.teamChatJudgeProvider && deps.env.teamChatJudgeModel) {
      selected.push({
        provider: deps.env.teamChatJudgeProvider,
        id: deps.env.teamChatJudgeModel,
        credential: await findModelCredential(
          deps.prisma,
          actor,
          deps.env.teamChatJudgeProvider,
          deps.env.teamChatJudgeModel,
        ),
        thinkingLevel: null,
      });
    }
    const models = [
      ...new Map(
        selected
          .filter((model) => model.provider)
          .map((model) => [
            JSON.stringify([model.provider, model.id, model.credential?.secretId]),
            model,
          ]),
      ).values(),
    ];
    const secrets = models.length
      ? await deps.prisma.secret.findMany({
          where: {
            userId: actor.userId,
            spaceId: null,
            id: {
              in: models.flatMap((model) => (model.credential ? [model.credential.secretId] : [])),
            },
          },
        })
      : [];
    const baseUrls = new Map(
      secrets.map((secret) => {
        const parsed = parseModelSecret(deps.secrets.load(secret.ciphertext, secret.id));
        return [secret.id, parsed.kind === "openai_compatible" ? parsed.baseUrl : undefined];
      }),
    );
    for (const model of models) {
      add(
        aiRecipient({
          provider: model.provider!,
          modelId: model.id!,
          baseUrl: model.credential ? baseUrls.get(model.credential.secretId) : undefined,
          use: "model",
        }),
      );
    }
  }
  for (const voice of voices)
    add(aiRecipient({ provider: voice.credential.provider, use: "voice" }));
  if (memory)
    add(
      aiRecipient({
        provider: memory.provider,
        use: "memory",
        baseUrl: toStringRecord(memory.settings).baseUrl,
      }),
    );
  if (
    uses.includes("model") &&
    deps.cloudAgent &&
    cloudAgentsEnabled(deps.cloudAgent, actor.spaceId) &&
    !deps.cloudAgent.provider.describe().capabilities.offline
  ) {
    add(aiRecipient({ provider: deps.cloudAgent.provider.describe().id, use: "model" }));
  }
  return {
    scope: createHash("sha256")
      .update(JSON.stringify([actor.userId, actor.spaceId]))
      .digest("hex"),
    version: AI_DISCLOSURE_VERSION,
    privacyUrl: deps.env.privacyPolicyUrl ?? AI_PRIVACY_URL,
    recipients: [...recipients.values()],
  };
}

export async function allowAiConsent(
  deps: RouterDeps,
  actor: Actor,
  input: { scope: string; version: string; keys: string[] },
) {
  const current = await aiConsentStatus(deps, actor);
  const known = new Set(current.recipients.map((recipient) => recipient.key));
  if (
    input.scope !== current.scope ||
    input.version !== current.version ||
    input.keys.some((key) => !known.has(key))
  ) {
    throw new ORPCError("CONFLICT", { message: "AI data sharing changed. Review it again." });
  }
  await deps.prisma.$transaction(
    input.keys.map((recipientKey) =>
      deps.prisma.aiDataConsent.upsert({
        where: {
          userId_spaceId_recipientKey: {
            userId: actor.userId,
            spaceId: actor.spaceId,
            recipientKey,
          },
        },
        create: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          recipientKey,
          version: current.version,
        },
        update: { version: current.version, grantedAt: new Date() },
      }),
    ),
  );
  return {
    ...current,
    recipients: current.recipients.map((recipient) =>
      input.keys.includes(recipient.key) ? { ...recipient, allowed: true } : recipient,
    ),
  };
}
