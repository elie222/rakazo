/**
 * CommandCode (https://commandcode.ai) is a model gateway: Claude answers on Anthropic's Messages
 * API, everything else on OpenAI's Chat Completions API. A model is served on the protocol its
 * `/models` entry lists, so each model carries the `api` and `baseUrl` it is reached on rather
 * than inheriting one protocol provider-wide. Claude ids answer only on `/messages`; a Chat
 * Completions request to them is rejected with 400.
 *
 * The table below is the published catalogue (`GET https://api.commandcode.ai/provider/v1/models`,
 * readable without a key). CommandCode publishes no pricing, so every model costs zero and only
 * API-key billing is offered for them.
 */
import type { Api, Model, MutableModels, Provider, ProviderStreams } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { DEFAULT_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import { guardToolCallNames } from "./pi-tool-call-guard.js";
import { disableCatalogProbe } from "./provider-traits.js";

export const COMMANDCODE_PROVIDER_ID = "commandcode";

/** Chat Completions root: the OpenAI SDK appends `/chat/completions`. */
const CHAT_BASE_URL = "https://api.commandcode.ai/provider/v1";

/** Messages root without the version segment: the Anthropic SDK appends `/v1/messages`. */
const MESSAGES_BASE_URL = "https://api.commandcode.ai/provider";

type CommandCodeProtocol = "chat" | "messages";

type CommandCodeSpec = readonly [
  id: string,
  label: string,
  contextWindow: number,
  protocol: CommandCodeProtocol,
];

/** `[id, label, context window, protocol]`, copied from the gateway's `/models` response. */
const COMMANDCODE_MODELS: readonly CommandCodeSpec[] = [
  ["MiniMaxAI/MiniMax-M2.5", "MiniMax M2.5", 200000, "chat"],
  ["MiniMaxAI/MiniMax-M2.7", "MiniMax M2.7", 200000, "chat"],
  ["MiniMaxAI/MiniMax-M3", "MiniMax M3", 1000000, "chat"],
  ["Qwen/Qwen3.6-Max-Preview", "Qwen 3.6 Max Preview", 200000, "chat"],
  ["Qwen/Qwen3.6-Plus", "Qwen 3.6 Plus", 200000, "chat"],
  ["Qwen/Qwen3.7-Flash", "Qwen 3.7 Flash", 1000000, "chat"],
  ["Qwen/Qwen3.7-Max", "Qwen 3.7 Max", 1000000, "chat"],
  ["Qwen/Qwen3.7-Plus", "Qwen 3.7 Plus", 1000000, "chat"],
  ["Qwen/Qwen3.8-27B", "Qwen 3.8 27B", 262144, "chat"],
  ["Qwen/Qwen3.8-Flash", "Qwen 3.8 Flash", 1000000, "chat"],
  ["Qwen/Qwen3.8-Max", "Qwen 3.8 Max", 1000000, "chat"],
  ["Qwen/Qwen3.8-Max-0902", "Qwen 3.8 Max 0902", 1000000, "chat"],
  ["Qwen/Qwen3.8-Max-Prime", "Qwen 3.8 Max Prime", 1000000, "chat"],
  ["Qwen/Qwen3.8-Omni-Flash", "Qwen 3.8 Omni Flash", 1000000, "chat"],
  ["claude-fable-5", "Claude Fable 5", 1000000, "messages"],
  ["claude-fable-5-1", "Claude Fable 5.1", 1000000, "messages"],
  ["claude-fable-5-2", "Claude Fable 5.2", 1000000, "messages"],
  ["claude-haiku-4-5-20251001", "Claude Haiku 4.5", 200000, "messages"],
  ["claude-haiku-5-5", "Claude Haiku 5.5", 1000000, "messages"],
  ["claude-opus-4-7", "Claude Opus 4.7", 1000000, "messages"],
  ["claude-opus-4-8", "Claude Opus 4.8", 1000000, "messages"],
  ["claude-opus-5", "Claude Opus 5", 1000000, "messages"],
  ["claude-opus-5-5", "Claude Opus 5.5", 1000000, "messages"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6", 1000000, "messages"],
  ["claude-sonnet-5", "Claude Sonnet 5", 1000000, "messages"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5", 1000000, "messages"],
  ["deepseek/deepseek-v4-flash", "DeepSeek V4 Flash (latest)", 1000000, "chat"],
  ["deepseek/deepseek-v4-flash-fast", "DeepSeek V4 Flash Fast", 1000000, "chat"],
  ["deepseek/deepseek-v4-flash-vision-exp", "DeepSeek V4 Flash Vision (exp)", 1000000, "chat"],
  ["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro (latest)", 1000000, "chat"],
  ["deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash (latest)", 1000000, "chat"],
  ["deepseek/deepseek-v4.1-flash-fast", "DeepSeek V4.1 Flash Fast (latest)", 1000000, "chat"],
  ["deepseek/deepseek-v4.1-flash-ultrafast", "DeepSeek V4.1 Flash Ultrafast", 1048576, "chat"],
  ["google/gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", 1000000, "chat"],
  ["google/gemini-3.5-flash", "Gemini 3.5 Flash", 1000000, "chat"],
  ["google/gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", 1000000, "chat"],
  ["google/gemini-3.6-flash", "Gemini 3.6 Flash", 1000000, "chat"],
  ["google/gemini-3.7-flash", "Gemini 3.7 Flash", 1048576, "chat"],
  ["google/gemini-3.8-flash", "Gemini 3.8 Flash", 1000000, "chat"],
  ["google/gemini-4-argon", "Gemini 4 Argon", 1000000, "chat"],
  ["google/gemini-4-carbon", "Gemini 4 Carbon", 1000000, "chat"],
  ["gpt-5.3-codex", "GPT-5.3 Codex", 400000, "chat"],
  ["gpt-5.4", "GPT-5.4", 400000, "chat"],
  ["gpt-5.4-mini", "GPT-5.4 Mini", 400000, "chat"],
  ["gpt-5.5", "GPT-5.5", 400000, "chat"],
  ["gpt-5.6-luna", "GPT-5.6 Luna", 1050000, "chat"],
  ["gpt-5.6-sol", "GPT-5.6 Sol", 1050000, "chat"],
  ["gpt-5.6-terra", "GPT-5.6 Terra", 1050000, "chat"],
  ["gpt-6-astra", "GPT-6 Astra", 1050000, "chat"],
  ["gpt-6-luna", "GPT-6 Luna", 1050000, "chat"],
  ["gpt-6-sol", "GPT-6 Sol", 1050000, "chat"],
  ["gpt-6.1-sol", "GPT-6.1 Sol", 1050000, "chat"],
  ["gpt-6.1-terra", "GPT-6.1 Terra", 1050000, "chat"],
  ["inclusionai/ling-3.1-flash", "Ling 3.1 Flash", 262144, "chat"],
  ["inclusionai/ling-3.1-flash-1019", "Ling 3.1 Flash 1019", 1000000, "chat"],
  ["meituan/LongCat-2.0", "LongCat 2.0", 1048576, "chat"],
  ["meta/muse-ember", "Muse Ember", 1048576, "chat"],
  ["meta/muse-spark-1.1", "Muse Spark 1.1", 1048576, "chat"],
  ["meta/muse-spark-1.2", "Muse Spark 1.2", 1048576, "chat"],
  ["meta/muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor", 1048576, "chat"],
  ["meta/muse-spark-1.3", "Muse Spark 1.3", 1048576, "chat"],
  ["meta/muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor", 1048576, "chat"],
  ["meta/muse-spark-open", "Muse Spark Open", 1048576, "chat"],
  ["meta/muse-wonder-1.0", "Muse Wonder", 1048576, "chat"],
  ["minimax/minimax-m3.1-flash", "MiniMax M3.1 Flash", 1000000, "chat"],
  ["mistral/mistral-large-4", "Mistral Large 4", 524288, "chat"],
  ["moonshotai/Kimi-K2.5", "Kimi K2.5", 256000, "chat"],
  ["moonshotai/Kimi-K2.6", "Kimi K2.6", 256000, "chat"],
  ["moonshotai/Kimi-K2.7-Code", "Kimi K2.7 Code", 256000, "chat"],
  ["moonshotai/Kimi-K2.7-Code-Highspeed", "Kimi K2.7 Code HighSpeed", 262000, "chat"],
  ["moonshotai/Kimi-K3", "Kimi K3", 1000000, "chat"],
  ["moonshotai/Kimi-K3.1-Pro", "Kimi K3.1 Pro", 1048576, "chat"],
  ["nvidia/nemotron-3-ultra-550b-a55b", "Nemotron 3 Ultra", 1000000, "chat"],
  ["nvidia/nemotron-3.5-super-vl", "Nemotron 3.5 Super VL", 262144, "chat"],
  ["ornith/ornith-1.5-122b", "Ornith 1.5 122B", 262144, "chat"],
  ["sakana/fugu-ultra", "Fugu Ultra", 1000000, "chat"],
  ["stealth/glyph-cluster:free", "Glyph Cluster", 256000, "chat"],
  ["stepfun/Step-3.5-Flash", "Step 3.5 Flash", 262144, "chat"],
  ["stepfun/Step-3.7-Flash", "Step 3.7 Flash", 256000, "chat"],
  ["stepfun/Step-5-Preview", "Step 5 Preview", 1000000, "chat"],
  ["tencent/hy3-paid", "Tencent Hy3", 262144, "chat"],
  ["tencent/hy4-preview", "Tencent Hy4 Preview", 1048576, "chat"],
  ["thinkingmachines/inkling", "Inkling", 256000, "chat"],
  ["thinkingmachines/inkling-2-small:free", "Inkling 2 Small", 1048576, "chat"],
  ["thinkingmachines/inkling-small", "Inkling Small", 1000000, "chat"],
  ["xai/grok-4.5", "Grok 4.5", 500000, "chat"],
  ["xai/grok-4.6", "Grok 4.6", 500000, "chat"],
  ["xai/grok-4.7", "Grok 4.7", 500000, "chat"],
  ["xiaomi/mimo-v2.6-flash", "MiMo V2.6 Flash", 1048576, "chat"],
  ["xiaomi/mimo-v2.6-pro", "MiMo V2.6 Pro", 1048576, "chat"],
  ["xiaomi/mimo-v2.6-pro-ultraspeed", "MiMo V2.6 Pro UltraSpeed", 1048576, "chat"],
  ["z-ai/glm-5.3-flash", "GLM-5.3 Flash", 1048576, "chat"],
  ["z-ai/glm-5.3-flashx", "GLM-5.3 FlashX", 1000000, "chat"],
  ["zai-org/GLM-5", "GLM-5", 200000, "chat"],
  ["zai-org/GLM-5.1", "GLM-5.1", 200000, "chat"],
  ["zai-org/GLM-5.2", "GLM-5.2", 1000000, "chat"],
  ["zai-org/GLM-5.2-Fast", "GLM-5.2 Fast", 1000000, "chat"],
  ["zai-org/GLM-5.3", "GLM-5.3", 1000000, "chat"],
];

function zeroCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/**
 * Claude thinking options belong to the model, not to the endpoint, so they are inherited from
 * the Anthropic catalogue entry for the same id: a new generation of a known model keeps the
 * thinking protocol of the generation it descends from. `allowedFallbackModels` is dropped,
 * because those fallbacks name the Anthropic provider and would route work away from this gateway.
 */
function anthropicTrait(base: MutableModels, id: string): Model<"anthropic-messages"> | undefined {
  const models = base.getProvider("anthropic")?.getModels() as
    | readonly Model<"anthropic-messages">[]
    | undefined;
  if (!models?.length) return undefined;
  const exact = models.find((model) => model.id === id);
  if (exact) return exact;
  return [...models]
    .filter((model) => id.startsWith(`${model.id}-`))
    .sort((left, right) => right.id.length - left.id.length)[0];
}

/** Model-level traits shared across providers, keyed by id, for models this gateway also serves. */
function siblingIndex(base: MutableModels): Map<string, Model<Api>> {
  const index = new Map<string, Model<Api>>();
  for (const provider of base.getProviders()) {
    if (provider.id === COMMANDCODE_PROVIDER_ID) continue;
    for (const model of provider.getModels()) {
      const known = index.get(model.id);
      if (known?.api === "openai-completions") continue;
      if (model.api === "openai-completions" || !known) index.set(model.id, model);
    }
  }
  return index;
}

function siblingModel(index: Map<string, Model<Api>>, id: string): Model<Api> | undefined {
  return index.get(id) ?? (id.includes("/") ? index.get(id.slice(id.indexOf("/") + 1)) : undefined);
}

function commandCodeModel(
  base: MutableModels,
  index: Map<string, Model<Api>>,
  [id, label, contextWindow, protocol]: CommandCodeSpec,
): Model<Api> {
  if (protocol === "messages") {
    const trait = anthropicTrait(base, id);
    const { allowedFallbackModels: _fallbacks, ...compat } = trait?.compat ?? {};
    return {
      id,
      name: label,
      provider: COMMANDCODE_PROVIDER_ID,
      api: "anthropic-messages",
      baseUrl: MESSAGES_BASE_URL,
      // Thinking support belongs to the model, not to the fact that an ancestor was found: a prefix
      // match on a model that cannot think must not hand the picker a knob the model rejects. An id
      // the Anthropic catalogue does not know yet keeps working, without a knob either.
      reasoning: trait?.reasoning ?? false,
      input: trait?.input ?? ["text", "image"],
      contextWindow,
      maxTokens: trait?.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS,
      cost: zeroCost(),
      ...(trait?.compat ? { compat } : {}),
      ...(trait?.thinkingLevelMap ? { thinkingLevelMap: trait.thinkingLevelMap } : {}),
    };
  }
  const trait = siblingModel(index, id);
  return {
    id,
    name: label,
    provider: COMMANDCODE_PROVIDER_ID,
    api: "openai-completions",
    baseUrl: CHAT_BASE_URL,
    // The gateway documents no reasoning parameters, so the thinking knob stays off rather than
    // sending `reasoning_effort` to models that may reject it.
    reasoning: false,
    input: trait?.input ?? ["text"],
    contextWindow,
    maxTokens: trait?.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS,
    cost: zeroCost(),
    // Proxy defaults: no `store`, no developer role, and `max_tokens` rather than the newer field.
    compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
  };
}

export function commandCodeCatalogProvider(base: MutableModels): Provider {
  const index = siblingIndex(base);
  const api: Partial<Record<Api, ProviderStreams>> = {
    "openai-completions": openAICompletionsApi(),
    "anthropic-messages": anthropicMessagesApi(),
  };
  return createProvider({
    id: COMMANDCODE_PROVIDER_ID,
    name: "CommandCode",
    baseUrl: CHAT_BASE_URL,
    auth: {
      apiKey: {
        name: "CommandCode API key",
        resolve: async ({ credential }) => {
          const apiKey = credential?.key?.trim();
          if (!apiKey) return undefined;
          return { auth: { apiKey }, source: "CommandCode API key" };
        },
      },
    },
    models: COMMANDCODE_MODELS.map((spec) => commandCodeModel(base, index, spec)),
    api,
  });
}

export function registerCommandCodeProvider(base: MutableModels): MutableModels {
  // The catalogue spans two endpoints, so a model list probed from the Chat Completions one would
  // record Claude ids as Chat Completions models and every request to them would be rejected. The
  // trait is declared here, where the endpoints are known, instead of the shared catalogue code
  // comparing a provider id.
  disableCatalogProbe(COMMANDCODE_PROVIDER_ID);
  // Several runtime tests replace Pi's bundled catalogue with a stub that only answers getModel, and
  // this provider's traits are read from the other providers, so registration has to accept a base
  // that cannot hold providers instead of failing the run it is building.
  if (typeof base.getProviders !== "function" || typeof base.setProvider !== "function")
    return base;
  base.setProvider(commandCodeCatalogProvider(base));
  return guardToolCallNames(base, COMMANDCODE_PROVIDER_ID);
}
