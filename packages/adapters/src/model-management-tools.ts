// Management-type bot tools: list and test the user's model connections
// (providers), so the bot can be managed from chat the way mickvvwai is
// managed from Telegram (/pmodels, /ptest). Switching the bot's own model
// already works through update_bot; these two fill the gap.
//
// Security: results never include an API key or any secret value. The list
// shows only labels, providers, model ids and whether a key is present.
// The test probes the provider live and reports only success/failure.
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { modelCredentialDto } from "./model-connect.js";
import { parseModelSecret } from "./model-secret.js";
import { loadStoredModelSecret } from "./model-selection.js";
import { verifyCatalogProviderApiKey } from "./pi-models.js";
import { probeOpenAiCompatibleModels } from "./pi-openai-compatible-provider.js";

type RunRef = { id: string; spaceId: string; userId: string };

const MAX_MODELS_SHOWN = 20;

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** list_model_connections: the user's model connections, without secrets. */
export async function listModelConnectionsFromTool(
  deps: ExecutorDeps,
  run: RunRef,
): Promise<Record<string, unknown>> {
  const rows = await deps.prisma.userModelCredential.findMany({
    where: { userId: run.userId },
    include: { userPreferences: { where: { userId: run.userId } } },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  if (rows.length === 0) {
    return {
      connections: [],
      message: "No model connections yet. Add one in Settings → Models.",
    };
  }
  const connections = [];
  for (const row of rows) {
    const preference = row.userPreferences[0];
    const own = {
      ...row,
      defaultModel: preference?.modelId ?? null,
      thinkingLevel: preference?.thinkingLevel ?? null,
    };
    const loaded = await loadStoredModelSecret(
      deps.prisma,
      deps.secretStore,
      run.userId,
      row.secretId,
    );
    const plaintext = loaded.status === "loaded" ? loaded.plaintext : undefined;
    const dto = modelCredentialDto(own, plaintext);
    const parsed = plaintext ? parseModelSecret(plaintext) : undefined;
    const enabledModelIds =
      parsed?.kind === "openai_compatible" ? (parsed.enabledModelIds ?? []) : [];
    const baseUrl = parsed?.kind === "openai_compatible" ? parsed.baseUrl : undefined;
    connections.push({
      id: row.id,
      provider: dto.provider,
      label: dto.label,
      ...(baseUrl ? { baseUrl } : {}),
      ...(dto.modelId ? { defaultModel: dto.modelId } : {}),
      ...(enabledModelIds.length > 0 ? { models: enabledModelIds.slice(0, MAX_MODELS_SHOWN) } : {}),
      ...(parsed?.kind === "openai_compatible" && parsed.authMode
        ? { authMode: parsed.authMode }
        : {}),
      hasKey: dto.hasKey,
      isDefault: dto.isDefault,
    });
  }
  return { connections };
}

/** test_model_connection: probe one connection live. */
export async function testModelConnectionFromTool(
  deps: ExecutorDeps,
  run: RunRef,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const query = asString(args.connection);
  if (!query) {
    return { error: "Tell me which connection to test: its label, provider, or id." };
  }
  const rows = await deps.prisma.userModelCredential.findMany({
    where: { userId: run.userId },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  const lower = query.toLowerCase();
  const row =
    rows.find((candidate) => candidate.id === query) ??
    rows.find((candidate) => candidate.label.toLowerCase() === lower) ??
    rows.find((candidate) => candidate.provider.toLowerCase() === lower);
  if (!row) {
    return {
      error: `No model connection matches "${query}". Use list_model_connections to see them.`,
    };
  }
  const loaded = await loadStoredModelSecret(
    deps.prisma,
    deps.secretStore,
    run.userId,
    row.secretId,
  );
  if (loaded.status !== "loaded") {
    return {
      error: `Could not read the saved key for "${row.label}". Reconnect it in Settings → Models.`,
    };
  }
  const parsed = parseModelSecret(loaded.plaintext);
  try {
    if (parsed.kind === "openai_compatible") {
      const models = await probeOpenAiCompatibleModels(
        {
          baseUrl: parsed.baseUrl,
          apiKey: parsed.apiKey,
          headers: parsed.headers,
          apiProtocol: parsed.apiProtocol,
          authMode: parsed.authMode,
        },
        undefined,
        undefined,
        { allowPrivate: true },
      );
      return {
        ok: true,
        connection: row.label,
        provider: row.provider,
        modelsFound: models.length,
        models: models.slice(0, MAX_MODELS_SHOWN),
        message:
          models.length > 0
            ? `"${row.label}" is reachable and lists ${models.length} model(s).`
            : `"${row.label}" is reachable but lists no models.`,
      };
    }
    if (parsed.kind === "api_key") {
      await verifyCatalogProviderApiKey(
        { provider: row.provider, apiKey: parsed.key },
        undefined,
        undefined,
      );
      return {
        ok: true,
        connection: row.label,
        provider: row.provider,
        message: `The key for "${row.label}" was accepted.`,
      };
    }
    return {
      error: `Cannot test "${row.label}" (OAuth connections are verified by reconnecting).`,
    };
  } catch (error) {
    getLogger().warn("model_connection.test_failed", {
      provider: row.provider,
      error: error instanceof Error ? error.message : "unknown",
    });
    return {
      ok: false,
      connection: row.label,
      provider: row.provider,
      message: error instanceof Error ? error.message : `Could not reach "${row.label}".`,
    };
  }
}
