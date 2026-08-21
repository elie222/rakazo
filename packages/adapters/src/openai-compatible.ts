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
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
      // Custom OpenAI-compatible proxies (Gemini, Ollama, LiteLLM, Groq, …) often
      // close the SSE stream after tokens without a terminal finish_reason chunk.
      // Pi treats that as a hard error unless this is off.
      supportsFinishReason: false,
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
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

export async function completeOpenAICompatibleChat(input: {
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  signal?: AbortSignal;
}): Promise<string> {
  const endpoint = `${normalizeOpenAICompatibleBaseUrl(input.baseUrl)}/chat/completions`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (input.apiKey?.trim()) headers.authorization = `Bearer ${input.apiKey.trim()}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    signal: input.signal,
    body: JSON.stringify({
      model: input.modelId,
      messages: input.messages,
      stream: false,
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Chat completion failed (${response.status})`);
  }
  const text = textFromOpenAICompatibleBody(raw, response.headers.get("content-type") ?? "");
  if (!text.trim()) throw new Error("The model returned an empty reply");
  return text;
}

export function textFromOpenAICompatibleBody(raw: string, contentType = ""): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (contentType.includes("text/event-stream") || trimmed.startsWith("data:")) {
    return textFromChatCompletionSse(trimmed);
  }
  try {
    return extractChatMessageText(JSON.parse(trimmed) as unknown);
  } catch {
    return trimmed.includes("data:") ? textFromChatCompletionSse(trimmed) : "";
  }
}

export function extractChatMessageText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choice = choices[0];
  if (!choice || typeof choice !== "object") return extractContent(record.content);
  const row = choice as Record<string, unknown>;
  const message =
    row.message && typeof row.message === "object"
      ? (row.message as Record<string, unknown>)
      : undefined;
  const delta =
    row.delta && typeof row.delta === "object" ? (row.delta as Record<string, unknown>) : undefined;
  return (
    extractContent(message?.content) ||
    extractContent(delta?.content) ||
    extractContent(row.content)
  );
}

function textFromChatCompletionSse(raw: string): string {
  let text = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      text += extractChatMessageText(JSON.parse(payload) as unknown);
    } catch {
      // Ignore malformed SSE lines from non-standard proxies.
    }
  }
  return text;
}

function extractContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      return "";
    })
    .join("");
}
