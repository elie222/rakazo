import type { Model, MutableModels, Provider, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { inputModalities } from "./model-modalities.js";

/**
 * Ollama Cloud: the hosted models at ollama.com, billed to an Ollama account and
 * reached with an API key over Ollama's OpenAI-compatible endpoint.
 *
 * Pi's bundled catalog does not ship this provider, so it is registered here like
 * the `local` provider. Unlike `local`, the host is fixed and public, the key is
 * required, and the catalog is real, so the live `/models` merge applies to it.
 */
export const OLLAMA_CLOUD_PROVIDER_ID = "ollama-cloud";

export const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";

/**
 * Ollama's public model list answers without a key, so the catalog probe cannot
 * tell a working key from a rejected one. The balance endpoint is cheap,
 * authenticated, and answers 401 for a bad key.
 */
export const OLLAMA_CLOUD_KEY_CHECK_URL = "https://ollama.com/api/balance";

/** A thinking value as Ollama's `/api/show` lists it under `thinking.values`. */
type OllamaThinkingValue = boolean | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Models that publish no thinking metadata accept the OpenAI effort names and
 * `"none"` to turn thinking off.
 */
const EFFORT_NAMES: readonly OllamaThinkingValue[] = [false, "low", "medium", "high", "max"];

type OllamaCloudModelSpec = {
  id: string;
  name: string;
  /**
   * `thinking.values` from `/api/show`: `false` means thinking can be turned
   * off, `true` means it is a switch without levels, and strings are the level
   * names the model accepts. Empty for a model that does not think.
   */
  thinking: readonly OllamaThinkingValue[];
  vision?: true;
  contextWindow: number;
  maxTokens: number;
};

/**
 * Cloud models as `GET https://ollama.com/api/tags` and `/api/show` describe
 * them. Ids are what the API expects (`gemma4:31b`, not the app's `gemma4:cloud`).
 * Dated snapshots and models added later arrive through the live model list.
 */
const OLLAMA_CLOUD_MODELS: readonly OllamaCloudModelSpec[] = [
  {
    id: "beam",
    name: "Beam 1.0",
    thinking: ["low", "medium", "high", "xhigh", "max"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
  },
  {
    id: "deepseek-v4-pro:0813",
    name: "DeepSeek V4 Pro 0813",
    thinking: [false, "low", "high", "max"],
    contextWindow: 1_048_576,
    maxTokens: 1_048_576,
  },
  {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    thinking: [false, "low", "high", "max"],
    vision: true,
    contextWindow: 1_048_576,
    maxTokens: 384_000,
  },
  {
    id: "gemma4:31b",
    name: "Gemma 4 31B",
    thinking: [false, true],
    vision: true,
    contextWindow: 262_144,
    maxTokens: 262_144,
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    thinking: [false, "high", "max"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
  },
  {
    id: "glm-5.3",
    name: "GLM-5.3",
    thinking: ["low", "high", "max"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
  },
  {
    id: "glm-5.3-flash",
    name: "GLM-5.3 Flash",
    thinking: ["low", "high", "max"],
    vision: true,
    contextWindow: 1_048_576,
    maxTokens: 131_072,
  },
  {
    id: "gpt-oss:120b",
    name: "GPT-OSS 120B",
    // GPT-OSS lists no `false`, but Ollama's compatibility layer reads `"none"` as no thinking.
    thinking: [false, "low", "medium", "high"],
    contextWindow: 131_072,
    maxTokens: 32_768,
  },
  {
    id: "gpt-oss:20b",
    name: "GPT-OSS 20B",
    thinking: [false, "low", "medium", "high"],
    contextWindow: 131_072,
    maxTokens: 32_768,
  },
  {
    id: "kimi-k2.6",
    name: "Kimi K2.6",
    thinking: [false, true],
    vision: true,
    contextWindow: 262_144,
    maxTokens: 262_144,
  },
  {
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    thinking: [false, true],
    vision: true,
    contextWindow: 262_144,
    maxTokens: 262_144,
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    thinking: [false, "low", "high", "max"],
    vision: true,
    contextWindow: 1_048_576,
    maxTokens: 131_072,
  },
  {
    id: "minimax-m2.7",
    name: "MiniMax M2.7",
    thinking: [true],
    contextWindow: 196_608,
    maxTokens: 196_608,
  },
  {
    id: "minimax-m3",
    name: "MiniMax M3",
    thinking: EFFORT_NAMES,
    vision: true,
    contextWindow: 512_000,
    maxTokens: 131_072,
  },
  {
    id: "minimax-m3.1-flash",
    name: "MiniMax M3.1 Flash",
    thinking: EFFORT_NAMES,
    vision: true,
    contextWindow: 1_000_000,
    maxTokens: 512_000,
  },
  {
    id: "mistral-large-3:675b",
    name: "Mistral Large 3 675B",
    thinking: [],
    vision: true,
    contextWindow: 262_144,
    maxTokens: 262_144,
  },
  {
    id: "mistral-large-4",
    name: "Mistral Large 4",
    thinking: EFFORT_NAMES,
    vision: true,
    contextWindow: 1_048_576,
    maxTokens: 262_144,
  },
  {
    id: "muse-spark-open",
    name: "Muse Spark Open",
    thinking: [false, "low", "medium", "high", "max"],
    vision: true,
    contextWindow: 1_048_576,
    maxTokens: 131_072,
  },
  {
    id: "nemotron-3-nano:30b",
    name: "Nemotron 3 Nano 30B",
    thinking: [false, true],
    contextWindow: 262_144,
    maxTokens: 131_072,
  },
  {
    id: "nemotron-3-super",
    name: "Nemotron 3 Super",
    thinking: [false, true],
    contextWindow: 262_144,
    maxTokens: 65_536,
  },
  {
    id: "nemotron-3-ultra",
    name: "Nemotron 3 Ultra",
    thinking: [false, true],
    contextWindow: 262_144,
    maxTokens: 128_000,
  },
];

const NAMED_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Pi levels the model really accepts, so the picker offers nothing Ollama would
 * quietly replace with the model default. Ollama turns thinking off for
 * `"none"`, and a switch-only model treats any effort name as "on", offered
 * here as a single `medium` level. `minimal` is only ever an alias for `low`.
 */
export function ollamaThinkingLevelMap(values: readonly OllamaThinkingValue[]): ThinkingLevelMap {
  const toggle = values.includes(true);
  const map: ThinkingLevelMap = {
    off: values.includes(false) ? "none" : null,
    minimal: null,
  };
  for (const level of NAMED_LEVELS) {
    map[level] = values.includes(level) ? level : toggle && level === "medium" ? level : null;
  }
  return map;
}

function ollamaCloudModel(spec: OllamaCloudModelSpec): Model<"openai-completions"> {
  const reasoning = spec.thinking.some((value) => value !== false);
  return {
    id: spec.id,
    name: spec.name,
    api: "openai-completions",
    provider: OLLAMA_CLOUD_PROVIDER_ID,
    baseUrl: OLLAMA_CLOUD_BASE_URL,
    reasoning,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: reasoning,
      thinkingFormat: "openai",
    },
    ...(reasoning ? { thinkingLevelMap: ollamaThinkingLevelMap(spec.thinking) } : {}),
    input: inputModalities(spec.vision === true),
    // Ollama bills by plan, not per token here, so usage carries no price estimate.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
  };
}

/**
 * The key comes only from the stored credential the request was authorized
 * with. Rakazo passes user keys explicitly, so there is no environment fallback.
 */
export function ollamaCloudProvider(): Provider {
  return createProvider({
    id: OLLAMA_CLOUD_PROVIDER_ID,
    name: "Ollama Cloud",
    baseUrl: OLLAMA_CLOUD_BASE_URL,
    auth: {
      apiKey: {
        name: "Ollama API key",
        resolve: async ({ credential, signal }) => {
          signal.throwIfAborted();
          if (!credential?.key) return undefined;
          return { auth: { apiKey: credential.key }, source: "stored credential" };
        },
      },
    },
    models: OLLAMA_CLOUD_MODELS.map(ollamaCloudModel),
    api: openAICompletionsApi(),
  });
}

export function registerOllamaCloudProvider(models: MutableModels): MutableModels {
  models.setProvider(ollamaCloudProvider());
  return models;
}
