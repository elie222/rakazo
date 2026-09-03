import {
  createProvider,
  type Model,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/**
 * Local OpenAI-compatible model server (Ollama, LM Studio, llama.cpp, MLX).
 *
 * Pi's built-in catalog only ships hosted providers, so a model running on the
 * operator's own machine has no catalog entry to select. This registers one
 * from environment configuration. The server is keyless: `resolve` returns a
 * placeholder because OpenAI-compatible local servers ignore the header, but
 * Models treats a provider with no resolvable auth as unconfigured and hides
 * its models.
 */
export const LOCAL_PROVIDER_ID = "local";

const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 4_096;

export function localBaseUrl(): string {
  const value = process.env.RAKAZO_LOCAL_MODELS_URL?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("RAKAZO_LOCAL_MODELS_URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("RAKAZO_LOCAL_MODELS_URL must be an absolute HTTP(S) URL");
  }
  return value;
}

/**
 * A token count from the environment, or the default when unset.
 *
 * Token limits are only meaningful as finite positive integers, so anything
 * else is a configuration mistake. Throwing beats `Number(x) || default`, which
 * would accept a negative window and silently swallow a typo as the default.
 */
function tokenLimit(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }
  return value;
}

/** Comma-separated model ids exactly as the local server names them. */
function localModelIds(): string[] {
  return (process.env.RAKAZO_LOCAL_MODELS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function localModel(id: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: LOCAL_PROVIDER_ID,
    baseUrl: localBaseUrl(),
    reasoning: false,
    input: ["text"],
    // Runs on the operator's own hardware, so there is nothing to bill.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: tokenLimit("RAKAZO_LOCAL_CONTEXT_WINDOW", DEFAULT_CONTEXT_WINDOW),
    maxTokens: tokenLimit("RAKAZO_LOCAL_MAX_TOKENS", DEFAULT_MAX_TOKENS),
  };
}

/** The provider, or undefined when no local models are configured. */
export function localProvider(): Provider | undefined {
  const ids = localModelIds();
  if (!ids.length) return undefined;
  return createProvider({
    id: LOCAL_PROVIDER_ID,
    name: "Local (Ollama / LM Studio)",
    baseUrl: localBaseUrl(),
    auth: {
      apiKey: {
        name: "Local model server",
        resolve: async () => ({
          auth: { apiKey: "local", baseUrl: localBaseUrl() },
          source: "local model server",
        }),
      },
    },
    models: ids.map(localModel),
    api: openAICompletionsApi(),
  });
}

/** Register the local provider on a Models collection. No-op when unconfigured. */
export function registerLocalProvider(models: MutableModels): MutableModels {
  const provider = localProvider();
  if (provider) models.setProvider(provider);
  return models;
}

/**
 * Provider id for a self-hosted MLX OpenAI-compatible server (mlx-openai-server /
 * Rapid MLX). Separate from `local` so an MLX endpoint and an Ollama endpoint can
 * coexist. The endpoint is keyless: `resolve` returns a placeholder header.
 */
export const LOCAL_MLX_PROVIDER_ID = "local-mlx";

const LOCAL_MLX_DEFAULT_BASE_URL = "http://127.0.0.1:8081/v1";
const LOCAL_MLX_CONTEXT_WINDOW = 128_000;
const LOCAL_MLX_MAX_TOKENS = 8_192;

/**
 * The MLX server base URL from `LOCAL_MLX_BASE_URL`, validated to be an absolute
 * HTTP(S) URL. Defaults to a local mlx-openai-server port.
 */
function localMlxBaseUrl(): string {
  const value = (process.env.LOCAL_MLX_BASE_URL ?? LOCAL_MLX_DEFAULT_BASE_URL).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("LOCAL_MLX_BASE_URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("LOCAL_MLX_BASE_URL must be an absolute HTTP(S) URL");
  }
  return value;
}

/** The model id exactly as the MLX server names it, from the environment. */
function localMlxModelId(): string {
  return (process.env.LOCAL_MLX_MODEL_ID ?? "").trim();
}

/** A reasoning-capable openai-completions model with Qwen chat-template thinking. */
function localMlxModel(id: string, baseUrl: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: LOCAL_MLX_PROVIDER_ID,
    baseUrl,
    reasoning: true,
    compat: {
      // mlx-openai-server rejects pi's default "developer" system role outright (422);
      // "system" is the role every such server understands.
      supportsDeveloperRole: false,
      // Qwen chat templates read chat_template_kwargs.enable_thinking; without this
      // the server defaults to reasoning_effort "xhigh" and can burn the whole
      // maxTokens budget on thinking before ever reaching an answer.
      thinkingFormat: "qwen-chat-template",
    },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: LOCAL_MLX_CONTEXT_WINDOW,
    maxTokens: LOCAL_MLX_MAX_TOKENS,
  };
}

/** The provider, or undefined when no MLX model id is configured. */
export function localMlxProvider(): Provider | undefined {
  const modelId = localMlxModelId();
  if (!modelId) return undefined;
  const baseUrl = localMlxBaseUrl();
  return createProvider({
    id: LOCAL_MLX_PROVIDER_ID,
    name: "Local MLX server",
    baseUrl,
    auth: {
      apiKey: {
        name: "Local MLX server",
        resolve: async () => ({
          auth: { apiKey: "not-required", baseUrl },
          source: "local MLX server",
        }),
      },
    },
    models: [localMlxModel(modelId, baseUrl)],
    api: openAICompletionsApi(),
  });
}

/** Register the local-mlx provider on a Models collection. No-op when unconfigured. */
export function registerLocalMlxProvider(models: MutableModels): MutableModels {
  const provider = localMlxProvider();
  if (provider) models.setProvider(provider);
  return models;
}
