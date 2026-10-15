import type {
  AgentRunModel,
  AgentRunRequest,
  AgentRuntimeEvent,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { ExecutionProfileModel, NativeLoginDescriptor } from "@rakazo/contracts";
import { nativeLoginEndpoint } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { parseModelSecret, secretValuesToRedact } from "./pi-oauth.js";
import { modelsForRequest } from "./pi-runtime.js";

/** A profile is an explicit account choice. Never consult deployment or default credentials. */
export async function resolveProfileModel(
  deps: { prisma: PrismaClient; secretStore: SecretStore },
  scope: { userId: string; spaceId?: string },
  profile: {
    provider: string;
    modelId: string;
    endpoint: string | null;
    harness?: string;
    computerId?: string | null;
    authScheme?: string;
    modelRoles?: unknown;
    inputModalities?: readonly string[];
  },
  credential: { id: string; secretId: string; userId: string },
): Promise<{ model: AgentRunModel; redact: string[] }> {
  if (credential.userId !== scope.userId)
    throw new Error("Execution profile account is not authorized");
  const row = await deps.prisma.secret.findFirst({
    where: { id: credential.secretId, userId: scope.userId, spaceId: null },
  });
  if (!row) throw new Error("Execution profile account is no longer available");
  const secret = parseModelSecret(await deps.secretStore.load(row.ciphertext, row.id));
  if (secret.kind === "native_login") {
    validateNativeLoginProfile(secret, profile, scope);
    return {
      model: {
        provider: profile.provider,
        id: profile.modelId,
        baseUrl: nativeLoginEndpoint(secret),
        nativeLogin: secret,
      },
      redact: [],
    };
  }
  if (profile.provider.startsWith("native-"))
    throw new Error("Native login account configuration is invalid. Reconnect the account.");
  if (secret.kind === "oauth") {
    throw new Error(
      "This harness requires an API-key connection; subscription login is not supported",
    );
  }
  const apiKey = secret.kind === "api_key" ? secret.key : secret.apiKey;
  if (!apiKey?.trim()) throw new Error("Execution profile account has no API key");
  return {
    model: {
      provider: profile.provider,
      id: profile.modelId,
      apiKey,
      baseUrl:
        profile.endpoint ?? (secret.kind === "openai_compatible" ? secret.baseUrl : undefined),
      maxTokens: secret.maxTokens,
    },
    redact: secretValuesToRedact(secret),
  };
}

/** An unexpected EOF is an interruption, never a successful native turn. */
export async function* requireRuntimeCompletion(
  events: AsyncIterable<AgentRuntimeEvent>,
): AsyncIterable<AgentRuntimeEvent> {
  let completed = false;
  for await (const event of events) {
    if (completed) throw new Error("Harness emitted an event after its terminal result");
    if (event.type === "done") completed = true;
    yield event;
  }
  if (!completed)
    throw new Error(
      "Harness interrupted before a terminal result; uncertain actions were not replayed",
    );
}

/** Other group members' output is context, not this bot's previous assistant response. */
export function profileHistoryMessage(
  message: { role: string; botId?: string | null },
  selfBotId: string,
  content: string,
): Pick<AgentRunRequest["history"][number], "role" | "content"> {
  if (message.role === "user" || message.role === "system") return { role: message.role, content };
  if (message.botId && message.botId !== selfBotId) {
    return { role: "user", content: `[Message from bot ${message.botId}]\n${content}` };
  }
  return { role: "assistant", content };
}

/** Validate Pi's actual driver, rather than accepting a decorative protocol setting. */
export function validatePiProfileModel(
  model: AgentRunModel,
  protocol: string,
  endpoint: string | null,
): void {
  if (endpoint && model.provider !== "openai-compatible") {
    throw new Error("Pi endpoint overrides require an OpenAI-compatible connection");
  }
  const configured = piExecutionProfileModel(model);
  if (!configured)
    throw new Error("The execution profile model is unavailable for its exact provider");
  if (configured.protocol !== protocol)
    throw new Error("The execution profile protocol does not match the Pi model driver");
}

/** Exact provider/driver metadata without a provider request or credential refresh. */
export function piExecutionProfileModel(model: AgentRunModel): ExecutionProfileModel | null {
  const configured = modelsForRequest({ model }, model.provider).getModel(model.provider, model.id);
  if (!configured) return null;
  const protocol =
    configured.api === "anthropic-messages"
      ? "anthropic"
      : configured.api === "openai-responses" || configured.api === "openai-codex-responses"
        ? "openai-responses"
        : configured.api === "openai-completions"
          ? "openai-chat-completions"
          : undefined;
  if (!protocol) return null;
  return {
    id: configured.id,
    label: configured.name,
    protocol,
    inputModalities: configured.input.includes("image") ? ["image"] : [],
  };
}

/** Native subscriptions are distinct scoped identities, never reusable API credentials. */
export function validateNativeLoginProfile(
  account: NativeLoginDescriptor,
  profile: {
    harness?: string;
    provider: string;
    endpoint: string | null;
    computerId?: string | null;
    authScheme?: string;
    modelRoles?: unknown;
    inputModalities?: readonly string[];
  },
  scope: { spaceId?: string },
): void {
  if (
    account.state !== "ready" ||
    account.spaceId !== scope.spaceId ||
    profile.harness !== account.harness ||
    profile.provider !== `native-${account.harness}` ||
    profile.computerId !== account.computerId ||
    profile.endpoint !== nativeLoginEndpoint(account) ||
    (profile.authScheme ?? "api-key") !== "api-key" ||
    (profile.modelRoles != null && Object.keys(profile.modelRoles as object).length > 0) ||
    profile.inputModalities?.includes("audio")
  ) {
    throw new Error(
      "Native login requires its ready account, original computer, matching harness, and official endpoint.",
    );
  }
}
