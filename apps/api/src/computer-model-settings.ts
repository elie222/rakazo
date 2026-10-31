import { ORPCError } from "@orpc/server";
import {
  connectionServesModel,
  enabledOpenAiCompatibleModelIds,
  loadStoredModelSecret,
  modelAcceptsImageInput,
  modelIdSupportsImages,
  parseModelSecret,
  prepareStoredModelAuth,
} from "@rakazo/adapters";
import type {
  Actor,
  ComputerModelSelection,
  ComputerModelTarget,
  ComputerModelView,
  ModelCatalogEntry,
} from "@rakazo/contracts";
import { ComputerModelSelectionSchema, canonicalPiProviderId } from "@rakazo/contracts";
import { findModelCredentialById, lockSpaceSettings, Prisma, settingsTarget } from "@rakazo/db";
import type { RouterDeps } from "./router.js";
import { withSerializableRetry } from "./serializable-retry.js";

type Deps = Pick<RouterDeps, "prisma" | "secrets" | "codexCatalog">;
const unavailable = () =>
  new ORPCError("BAD_REQUEST", {
    message: "Choose an available vision model on a connected account.",
  });

/** No probes, model calls, credential refreshes, environment keys or hosted-credit fallback. */
export function computerModelSettings(
  deps: Deps,
  catalog: (actor: Actor) => Promise<ModelCatalogEntry[]>,
) {
  const modelDeps = {
    prisma: deps.prisma,
    secretStore: deps.secrets,
    codexCatalog: deps.codexCatalog,
  };
  async function context(actor: Actor, target: ComputerModelTarget) {
    if (target.kind === "connection") {
      const credential = await findModelCredentialById(deps.prisma, actor, target.credentialId);
      if (!credential) throw new ORPCError("NOT_FOUND");
      return {
        credential,
        bot: null,
        scope: await settingsTarget(deps.prisma, actor, "models", target.scope),
      };
    }
    const bot = await deps.prisma.bot.findFirst({
      where: { id: target.botId, userId: actor.userId, spaceId: actor.spaceId },
    });
    if (!bot) throw new ORPCError("NOT_FOUND");
    return {
      credential: null,
      bot,
      scope: await settingsTarget(deps.prisma, actor, "models"),
    };
  }
  async function readSelection(
    actor: Actor,
    target: ComputerModelTarget,
    ctx: Awaited<ReturnType<typeof context>>,
  ): Promise<ComputerModelSelection> {
    if (target.kind === "bot")
      return ComputerModelSelectionSchema.parse(ctx.bot?.computerModel ?? null);
    const where = { userId: actor.userId, credentialId: target.credentialId };
    const row =
      ctx.scope === "account"
        ? await deps.prisma.userModelPreference.findFirst({ where })
        : await deps.prisma.spaceModelPreference.findFirst({
            where: { ...where, spaceId: actor.spaceId },
          });
    return row?.computerModelId
      ? ComputerModelSelectionSchema.parse({
          mode: "model",
          provider: row.computerProvider ?? canonicalPiProviderId(ctx.credential!.provider),
          credentialId: row.computerCredentialId ?? target.credentialId,
          modelId: row.computerModelId,
          thinkingLevel: row.computerThinkingLevel,
        })
      : null;
  }
  async function options(
    actor: Actor,
    credential: NonNullable<Awaited<ReturnType<typeof findModelCredentialById>>>,
    allEntries: ModelCatalogEntry[],
  ): Promise<ComputerModelView["options"]> {
    const stored = await loadStoredModelSecret(
      deps.prisma,
      deps.secrets,
      actor.userId,
      credential.secretId,
    );
    if (stored.status !== "loaded") return [];
    const secret = parseModelSecret(stored.plaintext);
    if (secret.kind === "oauth" && secret.reconnectRequired) return [];
    const provider = canonicalPiProviderId(credential.provider);
    // Deliberately one exact connection. Another account's live catalog cannot authorize it.
    const entries = allEntries.filter(
      (entry) =>
        entry.provider === provider && !entry.placeholder && entry.protocol !== "decisions",
    );
    const result: ComputerModelView["options"] = [];
    for (const entry of entries) {
      if (entry.credentialIds && !entry.credentialIds.includes(credential.id)) continue;
      if (
        secret.kind === "openai_compatible" &&
        !enabledOpenAiCompatibleModelIds(secret, credential.defaultModel).includes(entry.id)
      )
        continue;
      if (!(await connectionServesModel(modelDeps, actor.userId, credential, provider, entry.id)))
        continue;
      const auth = await prepareStoredModelAuth(
        deps.prisma,
        deps.secrets,
        actor.userId,
        credential.secretId,
        provider,
        entry.id,
        deps.codexCatalog,
      );
      if (auth.auth.status !== "ready") continue;
      const acceptsImages =
        secret.kind === "openai_compatible"
          ? modelIdSupportsImages(secret.visionModelIds, entry.id) ||
            (secret.visionModelIds === undefined &&
              "supportsImages" in credential &&
              credential.supportsImages === true &&
              credential.defaultModel === entry.id)
          : entry.images;
      if (acceptsImages === false || !modelAcceptsImageInput(provider, entry.id, acceptsImages))
        continue;
      result.push({
        mode: "model",
        provider,
        credentialId: credential.id,
        modelId: entry.id,
        label: `${entry.label} — ${credential.label ?? provider} (${provider}, ${secret.kind === "oauth" ? "OAuth" : secret.kind === "openai_compatible" && !secret.apiKey ? "local" : "API key"})`,
        thinkingLevels: entry.thinkingLevels ?? [],
      });
    }
    return result;
  }
  async function allOptions(actor: Actor): Promise<ComputerModelView["options"]> {
    const [rows, entries] = await Promise.all([
      deps.prisma.userModelCredential.findMany({
        where: { userId: actor.userId },
        select: { id: true },
      }),
      catalog(actor),
    ]);
    const choices = await Promise.all(
      rows.map(async (row) => {
        const credential = await findModelCredentialById(deps.prisma, actor, row.id);
        if (!credential) return [];
        // A disconnected/corrupt connection must not hide other choices or prevent clearing.
        try {
          return await options(actor, credential, entries);
        } catch {
          return [];
        }
      }),
    );
    return choices.flat();
  }
  async function load(actor: Actor, target: ComputerModelTarget): Promise<ComputerModelView> {
    const ctx = await context(actor, target);
    return {
      selection: await readSelection(actor, target, ctx),
      options: await allOptions(actor),
    };
  }
  async function save(
    actor: Actor,
    target: ComputerModelTarget,
    selection: ComputerModelSelection,
  ): Promise<ComputerModelView> {
    const ctx = await context(actor, target);
    if (selection?.mode === "model") {
      const allowed = (await allOptions(actor)).find(
        (entry) =>
          entry.provider === selection.provider &&
          entry.credentialId === selection.credentialId &&
          entry.modelId === selection.modelId,
      );
      if (!allowed) throw unavailable();
      if (selection.thinkingLevel && !allowed.thinkingLevels.includes(selection.thinkingLevel))
        throw unavailable();
    }
    await withSerializableRetry(() =>
      deps.prisma.$transaction(
        async (tx) => {
          await lockSpaceSettings(tx, actor);
          if (target.kind === "bot") {
            const changed = await tx.bot.updateMany({
              where: {
                id: target.botId,
                userId: actor.userId,
                spaceId: actor.spaceId,
                modelProvider: ctx.bot!.modelProvider,
                modelId: ctx.bot!.modelId,
              },
              data: { computerModel: selection ?? Prisma.DbNull },
            });
            if (changed.count !== 1) throw new ORPCError("CONFLICT");
          } else {
            const scope = await settingsTarget(tx, actor, "models", target.scope);
            const owner = await tx.userModelCredential.findFirst({
              where: {
                id: target.credentialId,
                userId: actor.userId,
                secretId: ctx.credential!.secretId,
              },
            });
            if (!owner || scope !== ctx.scope) throw new ORPCError("CONFLICT");
            const data = {
              computerProvider: selection?.mode === "model" ? selection.provider : null,
              computerCredentialId: selection?.mode === "model" ? selection.credentialId : null,
              computerModelId: selection?.mode === "model" ? selection.modelId : null,
              computerThinkingLevel:
                selection?.mode === "model" ? (selection.thinkingLevel ?? null) : null,
            };
            const key = { userId: actor.userId, credentialId: target.credentialId };
            if (scope === "account") {
              // Computer edits must not reorder the main model's connection preferences.
              const prior = await tx.userModelPreference.findFirst({ where: key });
              await tx.userModelPreference.upsert({
                where: { userId_credentialId: key },
                create: { ...key, ...data, hasMainPreference: false },
                update: { ...data, updatedAt: prior?.updatedAt ?? new Date(0) },
              });
            } else {
              const member = { ...key, spaceId: actor.spaceId };
              await tx.spaceModelPreference.upsert({
                where: { spaceId_userId_credentialId: member },
                create: { ...member, ...data },
                update: data,
              });
            }
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
    // Read the persisted target; clients never infer success from an optimistic echo.
    return load(actor, target);
  }
  return { load, save };
}
