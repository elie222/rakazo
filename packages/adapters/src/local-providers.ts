import { execFileSync } from "node:child_process";
import { createProvider, type ApiKeyAuth, type Model, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const OLLAMA_PROVIDER_ID = "ollama";
const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
const LOCAL_MLX_PROVIDER_ID = "local-mlx";
const LOCAL_MLX_DEFAULT_BASE_URL = "http://127.0.0.1:8081/v1";
const LOCAL_MLX_DEFAULT_MODEL_ID = "DreamFoundries/Ornith-1.0-35B-6bit";
const OLLAMA_LIST_TIMEOUT_MS = 3_000;
const DEFAULT_CONTEXT_WINDOW = 32_768;
const LOCAL_MLX_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/** Provider ids added by this module — used to give them local-appropriate billing copy. */
export const LOCAL_PROVIDER_IDS = new Set([OLLAMA_PROVIDER_ID, LOCAL_MLX_PROVIDER_ID]);

/** Ollama and self-hosted MLX servers take no API key; resolution always succeeds. */
function keylessAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: async () => ({ auth: { apiKey: "not-required" }, source: "none" }),
  };
}

function localModel(
  provider: string,
  baseUrl: string,
  id: string,
  contextWindow: number,
  reasoning = false,
): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl,
    reasoning,
    compat: {
      // Neither Ollama's nor mlx-openai-server's OpenAI-compatible endpoint recognizes the
      // newer "developer" role pi defaults to for the system prompt; mlx-openai-server rejects
      // it outright with a 422. "system" is the role every such server actually understands.
      supportsDeveloperRole: false,
      // mlx-openai-server's Qwen3.5 chat template reads chat_template_kwargs.enable_thinking;
      // without this, it defaults to reasoning_effort "xhigh" on every turn, which can burn the
      // whole maxTokens budget on <think> and never reach an answer.
      ...(reasoning ? { thinkingFormat: "qwen-chat-template" as const } : {}),
    },
    input: ["text"],
    contextWindow,
    maxTokens: DEFAULT_MAX_TOKENS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

/** `ollama list`'s first column, skipping the header row. Model names never contain whitespace. */
function listOllamaModelIds(): string[] {
  try {
    const stdout = execFileSync("ollama", ["list"], {
      encoding: "utf8",
      timeout: OLLAMA_LIST_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name): name is string => Boolean(name));
  } catch {
    return [];
  }
}

function ollamaProvider(): Provider<"openai-completions"> {
  const baseUrl = (process.env.OLLAMA_BASE_URL ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, "");
  return createProvider({
    id: OLLAMA_PROVIDER_ID,
    name: "Ollama (local)",
    baseUrl,
    auth: { apiKey: keylessAuth("Ollama — no key required") },
    models: listOllamaModelIds().map((id) =>
      localModel(OLLAMA_PROVIDER_ID, baseUrl, id, DEFAULT_CONTEXT_WINDOW),
    ),
    api: openAICompletionsApi(),
  });
}

function localMlxProvider(): Provider<"openai-completions"> {
  const baseUrl = (process.env.LOCAL_MLX_BASE_URL ?? LOCAL_MLX_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const modelId = process.env.LOCAL_MLX_MODEL_ID ?? LOCAL_MLX_DEFAULT_MODEL_ID;
  return createProvider({
    id: LOCAL_MLX_PROVIDER_ID,
    name: "Local MLX server",
    baseUrl,
    auth: { apiKey: keylessAuth("Local MLX server — no key required") },
    models: [localModel(LOCAL_MLX_PROVIDER_ID, baseUrl, modelId, LOCAL_MLX_CONTEXT_WINDOW, true)],
    api: openAICompletionsApi(),
  });
}

/**
 * Registers Ollama plus a configurable local OpenAI-compatible server (e.g. an
 * mlx-openai-server instance) on top of Pi's built-in provider catalog.
 * Ollama's model list is read from `ollama list` at startup; restart the API
 * process after pulling new models. The MLX entry is static, configured via
 * LOCAL_MLX_BASE_URL / LOCAL_MLX_MODEL_ID.
 */
export function withLocalProviders(models: MutableModels): MutableModels {
  models.setProvider(ollamaProvider());
  models.setProvider(localMlxProvider());
  return models;
}
