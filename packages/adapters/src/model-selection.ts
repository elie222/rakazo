import type { AgentRunRequest, SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { usableModelId } from "@rakazo/contracts";
import {
  chooseModelCredential,
  type findDefaultModelCredential,
  findModelCredential,
  type PrismaClient,
} from "@rakazo/db";
import type { ModelCredentialAuthKind } from "./pi-catalog-availability.js";
import {
  catalogModelAvailableForAuth,
  listAvailablePiCatalog,
  modelCredentialAuthKindFromPlaintext,
  UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE,
} from "./pi-catalog-availability.js";
import type { CodexLiveCatalog, CodexLiveReadOptions } from "./pi-codex-catalog.js";
import { codexLiveListsModel } from "./pi-codex-catalog.js";
import { listPiCatalog, scriptedCatalogEntry } from "./pi-models.js";
import { parseModelSecret } from "./pi-oauth.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";

type ModelCredential = Awaited<ReturnType<typeof findDefaultModelCredential>>;

export function isCatalogModelChoice(provider: string, modelId: string) {
  return [...listPiCatalog(), scriptedCatalogEntry].some(
    (item) => item.provider === provider && item.id === modelId,
  );
}

export function defaultCatalogModelId(
  provider: string,
  credentialPlaintext?: string,
): string | null {
  const authKind = credentialPlaintext
    ? modelCredentialAuthKindFromPlaintext(credentialPlaintext)
    : "disconnected";
  const authByProvider: Partial<Record<string, ModelCredentialAuthKind>> =
    authKind === "disconnected" ? {} : { [provider]: authKind };
  const entry = listAvailablePiCatalog(authByProvider).find((item) => item.provider === provider);
  return usableModelId(entry?.id);
}

export class UnavailableModelForAuthError extends Error {
  constructor(message = UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE) {
    super(message);
    this.name = "UnavailableModelForAuthError";
  }
}

export type SpaceCatalogAuth = {
  byProvider: Partial<Record<string, ModelCredentialAuthKind>>;
  /** Model-specific kinds. `"disconnected"` blocks the provider fallback. */
  byModel: Partial<
    Record<string, Partial<Record<string, ModelCredentialAuthKind | "disconnected">>>
  >;
  /**
   * Secret id of the credential governing each provider/model slot, so
   * per-account lookups (like the live Codex catalog) stay keyed to the
   * credential that would actually serve the model.
   */
  secretIdByProvider: Partial<Record<string, string>>;
  secretIdByModel: Partial<Record<string, Partial<Record<string, string>>>>;
};

/**
 * Auth kinds for the credentials `chooseModelCredential` would select in this space.
 * Each catalog model uses the preference that owns that model id, then the provider
 * preference, then the newest account credential. An unreadable selected secret stays
 * disconnected instead of falling through to an older key.
 */
export async function modelCredentialAuthKindsForSpace(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: Pick<Actor, "userId" | "spaceId">,
): Promise<SpaceCatalogAuth> {
  const [credentials, preferences] = await Promise.all([
    prisma.userModelCredential.findMany({
      where: { userId: scope.userId },
      select: {
        id: true,
        provider: true,
        secretId: true,
        updatedAt: true,
        createdAt: true,
      },
    }),
    prisma.spaceModelPreference.findMany({
      where: { userId: scope.userId, spaceId: scope.spaceId },
      select: {
        id: true,
        modelId: true,
        thinkingLevel: true,
        isDefault: true,
        updatedAt: true,
        credential: {
          select: {
            id: true,
            provider: true,
            secretId: true,
            updatedAt: true,
            createdAt: true,
          },
        },
      },
    }),
  ]);
  const connectedProviders = new Set([
    ...credentials.map((credential) => credential.provider),
    ...preferences.map((preference) => preference.credential.provider),
  ]);
  const selections: Array<{
    provider: string;
    modelId: string;
    secretId: string;
    modelSpecific: boolean;
  }> = [];
  for (const entry of listPiCatalog()) {
    if (!connectedProviders.has(entry.provider)) continue;
    const choice = chooseModelCredential({
      provider: entry.provider,
      modelId: entry.id,
      preferences,
      credentials,
    });
    if (!choice) continue;
    const secretId =
      choice.source === "preference"
        ? choice.preference.credential.secretId
        : choice.credential.secretId;
    const requestedModelId = usableModelId(entry.id);
    selections.push({
      provider: entry.provider,
      modelId: entry.id,
      secretId,
      modelSpecific:
        choice.source === "preference" &&
        requestedModelId !== null &&
        choice.preference.modelId === requestedModelId,
    });
  }
  const empty: SpaceCatalogAuth = {
    byProvider: {},
    byModel: {},
    secretIdByProvider: {},
    secretIdByModel: {},
  };
  if (selections.length === 0) return empty;

  const secrets = await prisma.secret.findMany({
    where: {
      id: { in: [...new Set(selections.map((selection) => selection.secretId))] },
      userId: scope.userId,
      spaceId: null,
    },
    select: { id: true, ciphertext: true },
  });
  const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
  // Every catalog model of a provider shares one secret; load each once per operation.
  const kindBySecretId = new Map<string, Promise<ModelCredentialAuthKind | undefined>>();
  const decryptKind = async (secretId: string): Promise<ModelCredentialAuthKind | undefined> => {
    const ciphertext = ciphertextById.get(secretId);
    if (!ciphertext) return undefined;
    try {
      return modelCredentialAuthKindFromPlaintext(await secretStore.load(ciphertext, secretId));
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) throw error;
      return undefined;
    }
  };
  const readKind = (secretId: string): Promise<ModelCredentialAuthKind | undefined> => {
    if (!kindBySecretId.has(secretId)) kindBySecretId.set(secretId, decryptKind(secretId));
    return kindBySecretId.get(secretId)!;
  };

  const auth: SpaceCatalogAuth = {
    byProvider: {},
    byModel: {},
    secretIdByProvider: {},
    secretIdByModel: {},
  };
  for (const selection of selections) {
    const kind = await readKind(selection.secretId);
    if (selection.modelSpecific) {
      const models = auth.byModel[selection.provider] ?? {};
      models[selection.modelId] = kind ?? "disconnected";
      auth.byModel[selection.provider] = models;
      const secrets = auth.secretIdByModel[selection.provider] ?? {};
      secrets[selection.modelId] = selection.secretId;
      auth.secretIdByModel[selection.provider] = secrets;
      continue;
    }
    if (kind) auth.byProvider[selection.provider] = kind;
    auth.secretIdByProvider[selection.provider] = selection.secretId;
  }
  return auth;
}

export function validateModelAuthAvailability(
  provider: string,
  modelId: string,
  credentialPlaintext?: string,
): string | undefined {
  if (!credentialPlaintext) return undefined;
  const authKind = modelCredentialAuthKindFromPlaintext(credentialPlaintext);
  const catalogEntry = listPiCatalog().find(
    (item) => item.provider === provider && item.id === modelId,
  );
  if (!catalogModelAvailableForAuth(provider, modelId, authKind, catalogEntry?.auth)) {
    return UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE;
  }
  return undefined;
}

function modelAuthIsRestricted(provider: string, modelId: string): boolean {
  const entry = listPiCatalog().find((item) => item.provider === provider && item.id === modelId);
  if (!entry) return false;
  return (["oauth", "api_key", "openai_compatible", "disconnected"] as const).some(
    (kind) => !catalogModelAvailableForAuth(provider, modelId, kind, entry.auth),
  );
}

/**
 * Ready credential to save as the space default.
 * The first ready credential in `orderedIds` wins, unless it already stores an
 * auth-restricted model and another ready credential can take the new default.
 */
export function selectDefaultCredentialId(input: {
  provider: string;
  modelId: string;
  orderedIds: readonly string[];
  readyIds: readonly string[];
  savedModelId: (credentialId: string) => string | null | undefined;
}): string | undefined {
  const ready = new Set(input.readyIds);
  const preferred = input.orderedIds.find((id) => ready.has(id));
  if (!preferred) return undefined;
  const saved = usableModelId(input.savedModelId(preferred));
  const requested = usableModelId(input.modelId);
  if (!saved || saved === requested) return preferred;
  const alternate = input.orderedIds.find((id) => id !== preferred && ready.has(id));
  if (!alternate || !modelAuthIsRestricted(input.provider, saved)) return preferred;
  return alternate;
}

export type StoredModelAuthRead =
  | { status: "ready" }
  | { status: "unreadable" }
  | { status: "rejected"; message: string };

/** Load credential auth outside transactions; retain the ref for a transactional recheck. */
export async function prepareStoredModelAuth(
  prisma: Pick<PrismaClient, "secret">,
  secretStore: Pick<SecretStore, "load">,
  userId: string,
  secretId: string,
  provider: string,
  modelId: string,
  live?: CodexLiveCatalog,
  liveOpts?: CodexLiveReadOptions,
): Promise<{ ref: string | null; auth: StoredModelAuthRead }> {
  const secret = await prisma.secret.findFirst({
    where: { id: secretId, userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  if (!secret) return { ref: null, auth: { status: "unreadable" } };
  let plaintext: string;
  try {
    plaintext = await secretStore.load(secret.ciphertext, secret.id);
  } catch (error) {
    if (error instanceof SecretStoreUnavailableError) throw error;
    return { ref: secret.ciphertext, auth: { status: "unreadable" } };
  }
  let message: string | undefined;
  try {
    message = validateModelAuthAvailability(provider, modelId, plaintext);
  } catch {
    // A secret that decrypts but does not parse is as unreadable as a corrupt one.
    return { ref: secret.ciphertext, auth: { status: "unreadable" } };
  }
  // validateModelAuthAvailability already parsed the secret without throwing.
  if (
    message &&
    (await codexLiveListsModel(live, userId, parseModelSecret(plaintext), modelId, liveOpts))
  ) {
    return { ref: secret.ciphertext, auth: { status: "ready" } };
  }
  return {
    ref: secret.ciphertext,
    auth: message ? { status: "rejected", message } : { status: "ready" },
  };
}

export async function readStoredModelAuth(
  ...args: Parameters<typeof prepareStoredModelAuth>
): Promise<StoredModelAuthRead> {
  return (await prepareStoredModelAuth(...args)).auth;
}

/** Readable rejection when a stored credential cannot call this catalog model. */
export async function validateStoredModelAuth(
  prisma: Pick<PrismaClient, "secret">,
  secretStore: Pick<SecretStore, "load">,
  userId: string,
  secretId: string,
  provider: string,
  modelId: string,
  live?: CodexLiveCatalog,
  liveOpts?: CodexLiveReadOptions,
): Promise<string | undefined> {
  const auth = await readStoredModelAuth(
    prisma,
    secretStore,
    userId,
    secretId,
    provider,
    modelId,
    live,
    liveOpts,
  );
  // Unreadable credentials fail when the run loads them, not as an auth mismatch.
  return auth.status === "rejected" ? auth.message : undefined;
}

export async function validateConnectedModelChoice(
  prisma: PrismaClient,
  actor: Pick<Actor, "userId" | "spaceId">,
  provider: string,
  modelId: string,
) {
  const credential = await findModelCredential(prisma, actor, provider);
  if (!credential) return "Connect that model provider first";
  if (!usableModelId(modelId)) return "Unknown model for that provider";
  if (isCatalogModelChoice(provider, modelId)) return undefined;
  // Free-form saved IDs only resolve at runtime for openai-compatible connections.
  if (provider !== OPENAI_COMPATIBLE_PROVIDER_ID) {
    return "Unknown model for that provider";
  }
  const savedChoice = await prisma.spaceModelPreference.findFirst({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      modelId,
      credential: { userId: actor.userId, provider },
    },
    select: { id: true },
  });
  return savedChoice ? undefined : "Unknown model for that provider";
}

export type ModelChoice = {
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
};

/**
 * The model a queued run will use. `modelPinned` is the choice captured when the
 * run was created. Model columns written later only record the attempt, so a
 * routine that follows its bot still follows the bot after a resume.
 */
export function runModelChoice(
  run: ModelChoice & { modelPinned?: boolean },
  bot: ModelChoice,
): ModelChoice {
  if (run.modelPinned && run.modelProvider && usableModelId(run.modelId)) {
    return {
      modelProvider: run.modelProvider,
      modelId: run.modelId,
      thinkingLevel: run.thinkingLevel,
    };
  }
  return {
    modelProvider: bot.modelProvider,
    modelId: bot.modelId,
    thinkingLevel: bot.thinkingLevel,
  };
}

/** The model columns a routine's run starts with; empty when it follows the bot. */
export function routineRunModelPin(routine: ModelChoice): {
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: string | null;
  modelPinned?: true;
} {
  if (!routine.modelProvider || !routine.modelId) return {};
  return {
    modelProvider: routine.modelProvider,
    modelId: routine.modelId,
    thinkingLevel: routine.thinkingLevel,
    modelPinned: true,
  };
}

/**
 * One inbound delivery is one turn. Pin a model only when every routine in that
 * delivery chose the same one; mixed choices stay on the bot's model.
 */
export function inboundRoutineModelPin(routines: readonly ModelChoice[]) {
  const pins = routines.map((routine) => routineRunModelPin(routine));
  const first = pins[0];
  if (!first) return {};
  const agreed = pins.every(
    (pin) =>
      pin.modelPinned === first.modelPinned &&
      pin.modelProvider === first.modelProvider &&
      pin.modelId === first.modelId &&
      (pin.thinkingLevel ?? null) === (first.thinkingLevel ?? null),
  );
  return agreed ? first : {};
}

/** Why a pinned model cannot run on the credential that was found for it. */
export function pinnedModelCredentialError(
  choice: ModelChoice,
  credential: { defaultModel: string | null } | null,
): string | undefined {
  if (!choice.modelProvider || !usableModelId(choice.modelId)) return undefined;
  if (!credential) return "Connect that model provider first";
  const modelId = usableModelId(choice.modelId);
  if (
    modelId &&
    !isCatalogModelChoice(choice.modelProvider, modelId) &&
    credential.defaultModel !== modelId
  ) {
    return "Unknown model for that provider";
  }
  return undefined;
}

/** Select configuration without loading secrets or applying a runtime-specific fallback. */
export function selectConfiguredModel(input: {
  /** The bot's or the run's own model; null follows the space default. */
  override: ModelChoice | null;
  overrideCredential: ModelCredential;
  defaultCredential: ModelCredential;
  settings: { defaultModelProvider: string | null; defaultModelId: string | null } | null;
  deployment: { provider: string; model: string } | null;
}) {
  const { override: bot, overrideCredential, defaultCredential, settings, deployment } = input;
  const hasOverride = Boolean(bot?.modelProvider && usableModelId(bot.modelId));
  // The override provider, model and credential must win together.
  const useOverride = Boolean(hasOverride && overrideCredential);
  const credential = useOverride ? overrideCredential : defaultCredential;
  const id =
    usableModelId(useOverride ? bot!.modelId : null) ??
    usableModelId(credential?.defaultModel) ??
    (credential ? defaultCatalogModelId(credential.provider) : null) ??
    usableModelId(settings?.defaultModelId) ??
    usableModelId(deployment?.model);
  // A preference's thinking level is bound to its stored modelId, so it only applies
  // when that model is the one being run.
  const credentialThinkingLevel =
    credential && id && credential.defaultModel === id ? credential.thinkingLevel : null;
  return {
    provider:
      (useOverride ? bot!.modelProvider : null) ??
      credential?.provider ??
      settings?.defaultModelProvider ??
      deployment?.provider,
    id,
    credential,
    // Preserve bot thinking for the Space default; drop it for an unavailable override.
    thinkingLevel:
      hasOverride && !useOverride
        ? null
        : (((bot?.thinkingLevel ??
            credentialThinkingLevel) as AgentRunRequest["model"]["thinkingLevel"]) ?? null),
  };
}
