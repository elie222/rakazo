import type { ModelUsageLookup } from "@rakazo/adapter-kit";
import type { ModelOAuthSignInMode, ModelRoutingField } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging";
import {
  CLAUDE_CODE_CREDENTIAL_SOURCE,
  CLAUDE_CODE_PROVIDER_ID,
} from "../providers/cli-model/claude-code/provider-id.js";
import { OpenRouterUsageLookup } from "./endpoints/openrouter-usage.js";

/**
 * What Rakazo knows about a model provider beyond the model registry it runs on. A provider
 * without an entry is used exactly as the registry describes it.
 */
export interface ModelProviderDefinition {
  /** Kept where the registry renamed a provider, so existing names stay. */
  displayName?: string;
  /** The model a new connection preselects; only an exact catalog id. */
  recommendedModel?: string;
  /** Bundled or live-listed ids the provider refuses agent runs for every new account. */
  unservedModels?: readonly string[];
  /** A read-only authenticated endpoint that tells a rejected key from a valid one. */
  keyCheck?: {
    url: string;
    headers(apiKey: string): Record<string, string>;
    rejected(response: Response): Promise<boolean>;
  };
  /** A deployment-wide key operators set in the environment, and the model it runs. */
  deployment?: { keyEnv: string; defaultModel: string };
  /** Optional authenticated recovery of a dispatched request. */
  usageLookup?: (apiKey: string) => ModelUsageLookup;
  /** Host credentials it can run on instead of a key, e.g. "AWS IAM". */
  hostCredentials?: {
    source: string;
    /** Resolved when a request is made, so the environment cannot report them up front. */
    resolvedAtRequest?: boolean;
  };
  /** Subscription sign-in Rakazo offers. */
  signIn?: {
    mode: ModelOAuthSignInMode;
    loginLabel: string;
    hint: string;
    billing: string;
    /** A setting the account must turn on first, or the provider refuses the sign-in. */
    setup?: { label: string; url: string };
  };
  /** Ids each connection supplies to route its requests. */
  routingFields?: ModelRoutingField[];
  /** A connection can ask that requests only reach endpoints that keep no prompts or replies. */
  dataRetentionControl?: true;
}

const bearer = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}` });
const unauthorized = async (response: Response) =>
  response.status === 401 || response.status === 403;

export const modelProviders = {
  "openai-codex": {
    displayName: "OpenAI Codex",
    recommendedModel: "gpt-6-luna",
    signIn: {
      mode: "device-code",
      loginLabel: "Sign in with ChatGPT",
      hint: "ChatGPT Plus/Pro",
      billing:
        "Sign in with ChatGPT Plus or Pro. Uses your OpenAI subscription. Rakazo does not pay.",
      setup: {
        label: "Turn on device code sign-in in ChatGPT security settings",
        url: "https://chatgpt.com/#settings/Security",
      },
    },
  },
  openai: { recommendedModel: "gpt-6-luna" },
  openrouter: {
    usageLookup: (apiKey: string) => new OpenRouterUsageLookup(apiKey),
    recommendedModel: "anthropic/claude-haiku-5.5",
    keyCheck: {
      url: "https://openrouter.ai/api/v1/key",
      headers: bearer,
      rejected: unauthorized,
    },
    deployment: { keyEnv: "OPENROUTER_API_KEY", defaultModel: "anthropic/claude-haiku-5.5" },
    dataRetentionControl: true,
  },
  anthropic: {
    recommendedModel: "claude-haiku-5-5",
    deployment: { keyEnv: "ANTHROPIC_API_KEY", defaultModel: "claude-sonnet-5" },
    signIn: {
      mode: "auth-url",
      loginLabel: "Sign in with Claude",
      hint: "Claude Pro/Max / key",
      // Button + "Or paste an API key" already explain the choices; no extra paragraph.
      billing: "",
    },
  },
  google: {
    recommendedModel: "gemini-4-hydrogen",
    // "No longer available to new users" (the 2.5 family).
    unservedModels: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"],
    keyCheck: {
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      headers: (apiKey) => ({ "x-goog-api-key": apiKey }),
      // Invalid keys come back as HTTP 400 with a structured ErrorInfo reason.
      rejected: (response) =>
        response.status === 400 ? googleKeyWasRejected(response) : unauthorized(response),
    },
  },
  "google-vertex": {
    recommendedModel: "gemini-4-hydrogen",
    hostCredentials: { source: "Google Cloud" },
    routingFields: ["projectId", "region"],
  },
  // Retired, answered with "does not exist" / "no longer available".
  groq: {
    recommendedModel: "openai/gpt-oss-120b",
    unservedModels: ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"],
  },
  minimax: { recommendedModel: "MiniMax-M3", unservedModels: ["MiniMax-M2.7"] },
  "github-copilot": {
    // "Not available for integrator", the Copilot integration the registry identifies as.
    unservedModels: ["gemini-3.7-flash", "grok-4.5", "mai-code-1-flash-picker"],
    signIn: {
      mode: "device-code",
      loginLabel: "Sign in with GitHub Copilot",
      hint: "Copilot",
      billing: "Sign in with GitHub Copilot. Uses your Copilot subscription. Rakazo does not pay.",
    },
  },
  xai: {
    signIn: {
      mode: "device-code",
      loginLabel: "Sign in with SuperGrok or X Premium",
      hint: "SuperGrok / key",
      billing: "Sign in with SuperGrok or X Premium, or paste an xAI API key. Rakazo does not pay.",
    },
  },
  deepseek: {
    keyCheck: { url: "https://api.deepseek.com/models", headers: bearer, rejected: unauthorized },
    deployment: { keyEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek-flash" },
  },
  "cloudflare-workers-ai": { recommendedModel: "@cf/openai/gpt-oss-20b" },
  azure: { displayName: "Azure OpenAI" },
  // Also resolves EC2 instance roles through IMDS at request time.
  "amazon-bedrock": { hostCredentials: { source: "AWS IAM", resolvedAtRequest: true } },
  [CLAUDE_CODE_PROVIDER_ID]: {
    hostCredentials: { source: CLAUDE_CODE_CREDENTIAL_SOURCE, resolvedAtRequest: true },
  },
} satisfies Record<string, ModelProviderDefinition>;

export function modelProviderDefinition(id: string): ModelProviderDefinition | undefined {
  return Object.hasOwn(modelProviders, id)
    ? (modelProviders as Record<string, ModelProviderDefinition>)[id]
    : undefined;
}

async function googleKeyWasRejected(response: Response): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return false;
  try {
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) return false;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const body = JSON.parse(text) as { error?: { details?: Array<{ reason?: string }> } };
    return (
      Array.isArray(body.error?.details) &&
      body.error.details.some((detail) => detail?.reason === "API_KEY_INVALID")
    );
  } catch {
    return false;
  } finally {
    void bestEffort("cancel key check response", reader.cancel());
    reader.releaseLock();
  }
}
