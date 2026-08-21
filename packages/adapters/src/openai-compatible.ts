import { createProvider, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const OPENAI_COMPATIBLE_PROVIDER = "openai-compatible";
export const GATEWAY_PROVIDER_PREFIX = "gateway:";

export function isGatewayProvider(provider: string): boolean {
  return provider === OPENAI_COMPATIBLE_PROVIDER || provider.startsWith(GATEWAY_PROVIDER_PREFIX);
}

export function mintGatewayProviderId(): string {
  return `${GATEWAY_PROVIDER_PREFIX}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function normalizeOpenAICompatibleBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Enter a base URL");
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    throw new Error("Base URL must be http or https");
  }
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error("Enter a valid http(s) base URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL must be http or https");
  }
  parsed.hash = "";
  parsed.search = "";
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path || "/";
  return parsed.toString().replace(/\/+$/, "");
}

export function parseAvailableModels(value: string | null | undefined): string[] {
  if (!value?.trim()) return [];
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

export function serializeAvailableModels(models: string[]): string {
  return [...new Set(models.map((entry) => entry.trim()).filter(Boolean))].join("\n");
}

export function modelsFromKeyCoverage(value: string | string[] | null | undefined): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((entry) => entry.trim()).filter(Boolean))]
    : parseAvailableModels(value);
}

export function unionAvailableModels(
  keys: Array<{ availableModels?: string | string[] | null }>,
): string[] {
  return [...new Set(keys.flatMap((key) => modelsFromKeyCoverage(key.availableModels)))];
}

export function secretIdForGatewayModel(
  credential: {
    secretId: string;
    keys: Array<{
      secretId: string;
      isActive: boolean;
      availableModels?: string | string[] | null;
    }>;
  },
  modelId?: string | null,
): string {
  const fallback = credential.keys.find((key) => key.isActive)?.secretId ?? credential.secretId;
  if (!modelId?.trim() || !credential.keys.length) return fallback;
  const matching = credential.keys.filter((key) =>
    modelsFromKeyCoverage(key.availableModels).includes(modelId),
  );
  if (!matching.length) return fallback;
  return matching.find((key) => key.isActive)?.secretId ?? matching[0]!.secretId;
}

const MODEL_FAMILY_LABELS: Array<[string, string]> = [
  ["gemini", "Gemini"],
  ["claude", "Claude"],
  ["gpt", "GPT"],
  ["o1", "OpenAI"],
  ["o3", "OpenAI"],
  ["o4", "OpenAI"],
  ["llama", "Llama"],
  ["mistral", "Mistral"],
  ["grok", "Grok"],
  ["deepseek", "DeepSeek"],
  ["qwen", "Qwen"],
  ["command", "Command"],
];

export function labelForDiscoveredModels(models: string[], fallback = "API key"): string {
  if (!models.length) return fallback;
  const lower = models.map((id) => id.toLowerCase());
  for (const [needle, label] of MODEL_FAMILY_LABELS) {
    const hits = lower.filter((id) => id.includes(needle)).length;
    if (hits === models.length || hits >= Math.max(1, Math.ceil(models.length * 0.7))) {
      return label;
    }
  }
  return fallback;
}

export async function tryFetchOpenAICompatibleModels(
  baseUrl: string,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<{ models: string[]; error: string }> {
  try {
    return { models: await fetchOpenAICompatibleModels(baseUrl, apiKey, signal), error: "" };
  } catch (error) {
    return {
      models: [],
      error: error instanceof Error ? error.message : "Could not list models",
    };
  }
}

export async function fetchOpenAICompatibleModels(
  baseUrl: string,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const endpoint = `${normalizeOpenAICompatibleBaseUrl(baseUrl)}/models`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey?.trim()) headers.authorization = `Bearer ${apiKey.trim()}`;
  const response = await fetch(endpoint, { headers, signal });
  if (!response.ok) {
    throw new Error(`Could not list models (${response.status})`);
  }
  const body = (await response.json()) as { data?: unknown; models?: unknown };
  const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  const ids = rows.flatMap((row) => {
    if (typeof row === "string") return [row];
    if (row && typeof row === "object" && "id" in row) return [String((row as { id: unknown }).id)];
    return [];
  });
  if (!ids.length) throw new Error("That endpoint did not return any models");
  return [...new Set(ids)];
}

export function openaiCompatibleModel(
  provider: string,
  modelId: string,
  baseUrl: string,
): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider,
    baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
    },
  };
}

export function attachOpenAICompatibleProvider(
  models: MutableModels,
  input: {
    provider: string;
    baseUrl: string;
    modelId: string;
    apiKey?: string;
    extraModelIds?: string[];
  },
): void {
  const baseUrl = normalizeOpenAICompatibleBaseUrl(input.baseUrl);
  const ids = [...new Set([input.modelId, ...(input.extraModelIds ?? [])].filter(Boolean))];
  models.setProvider(
    createProvider({
      id: input.provider,
      name: input.provider,
      baseUrl,
      auth: {
        apiKey: {
          name: "Custom endpoint",
          resolve: async () => ({
            auth: input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {},
          }),
        },
      },
      models: ids.map((id) => openaiCompatibleModel(input.provider, id, baseUrl)),
      api: openAICompletionsApi(),
    }),
  );
}
