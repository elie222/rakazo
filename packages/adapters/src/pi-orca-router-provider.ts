import {
  createProvider,
  envApiKeyAuth,
  type Model,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/**
 * OrcaRouter is an OpenAI-compatible AI gateway that mirrors the
 * provider/model namespace OpenRouter exposes, so it slots into the same
 * catalog as a first-class provider instead of an anonymous custom base URL.
 * The base URL is fixed and the model list is curated from the gateway's
 * /models endpoint (the same public models any OrcaRouter key can call).
 */
export const ORCAROUTER_PROVIDER_ID = "orcarouter";

const ORCAROUTER_BASE_URL = "https://api.orcarouter.ai/v1";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 32_768;

type OrcaRouterModelOptions = {
  /** Models that do their own reasoning before answering must not start at "off". */
  reasoning?: boolean;
  /** Models that accept image input. */
  vision?: boolean;
};

function orcaRouterModel(
  id: string,
  options: OrcaRouterModelOptions = {},
): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: ORCAROUTER_PROVIDER_ID,
    baseUrl: ORCAROUTER_BASE_URL,
    reasoning: options.reasoning ?? false,
    input: options.vision ? ["text", "image"] : ["text"],
    // Billed through the gateway key; Rakazo does not pay for model usage.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

function orcaRouterModels(): Model<"openai-completions">[] {
  return [
    // Adaptive routing and OrcaRouter's own model namespace.
    orcaRouterModel("orcarouter/auto", { reasoning: true }),
    orcaRouterModel("orcarouter/free"),
    orcaRouterModel("orcarouter/fusion", { reasoning: true }),
    orcaRouterModel("orcarouter/fusion-flash"),
    orcaRouterModel("orcarouter/fusion-mini"),
    orcaRouterModel("orcarouter/orcacode-review", { reasoning: true }),
    orcaRouterModel("orcarouter/open-code", { reasoning: true }),
    // Anthropic
    orcaRouterModel("anthropic/claude-fable-5", { reasoning: true, vision: true }),
    orcaRouterModel("anthropic/claude-opus-4.8", { reasoning: true, vision: true }),
    orcaRouterModel("anthropic/claude-sonnet-5", { reasoning: true, vision: true }),
    orcaRouterModel("anthropic/claude-haiku-4.5", { reasoning: true, vision: true }),
    // DeepSeek
    orcaRouterModel("deepseek/deepseek-v4-flash-0731"),
    orcaRouterModel("deepseek/deepseek-v4-pro-0813", { reasoning: true }),
    orcaRouterModel("deepseek/deepseek-reasoner", { reasoning: true }),
    // Google
    orcaRouterModel("google/gemini-3.5-flash", { vision: true }),
    orcaRouterModel("google/gemini-3.1-pro-preview", { reasoning: true, vision: true }),
    orcaRouterModel("google/gemini-2.5-flash", { vision: true }),
    // Grok
    orcaRouterModel("grok/grok-4.6", { vision: true }),
    // OpenAI
    orcaRouterModel("openai/gpt-5.5", { reasoning: true }),
    orcaRouterModel("openai/gpt-5.4", { reasoning: true }),
    orcaRouterModel("openai/gpt-5.2", { reasoning: true }),
    orcaRouterModel("openai/gpt-5.6-luna", { reasoning: true }),
    orcaRouterModel("openai/gpt-4o", { vision: true }),
    orcaRouterModel("openai/gpt-4o-mini", { vision: true }),
    // Qwen
    orcaRouterModel("qwen/qwen3.8-flash"),
    orcaRouterModel("qwen/qwen3.8-max", { reasoning: true }),
    orcaRouterModel("qwen/qwen3-vl-235b-a22b-instruct", { vision: true }),
    // Z.ai
    orcaRouterModel("z-ai/glm-5.3", { reasoning: true }),
    orcaRouterModel("z-ai/glm-5.2"),
    // Kimi
    orcaRouterModel("kimi/kimi-k2.7-code", { reasoning: true }),
    // Meta
    orcaRouterModel("meta/muse-spark-1.2", { reasoning: true }),
  ];
}

export function orcaRouterProvider(): Provider {
  return createProvider({
    id: ORCAROUTER_PROVIDER_ID,
    name: "OrcaRouter",
    baseUrl: ORCAROUTER_BASE_URL,
    auth: {
      apiKey: envApiKeyAuth("OrcaRouter API key", ["ORCAROUTER_API_KEY"]),
    },
    models: orcaRouterModels(),
    api: openAICompletionsApi(),
  });
}

/** Register the OrcaRouter provider on a Models collection. */
export function registerOrcaRouterCatalog(models: MutableModels): MutableModels {
  models.setProvider(orcaRouterProvider());
  return models;
}
