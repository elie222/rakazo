import type {
  Api,
  Model,
  Models,
  MutableModels,
  Provider,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { CLAUDE_CODE_PROVIDER_ID } from "./claude-code-provider-id.js";
import { streamClaudeCode } from "./claude-code-stream.js";
import { resolveDeploymentModel } from "./deployment-model.js";

export { CLAUDE_CODE_PROVIDER_ID };

const CLAUDE_CODE_API = "claude-code-cli";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 32_000;

/** Why this server may not run models through the CLI right now, or undefined when it may. */
export type ClaudeCodeAccessCheck = () => Promise<string | undefined>;

let accessCheck: ClaudeCodeAccessCheck | undefined;

/** Installed by the run runtime, which can see billing and accounts; until then every call is refused. */
export function setClaudeCodeAccessCheck(check: ClaudeCodeAccessCheck | undefined): void {
  accessCheck = check;
}

async function assertAllowed(): Promise<void> {
  const refusal = accessCheck
    ? await accessCheck()
    : "Claude Code runs only inside the Rakazo API and worker.";
  if (refusal) throw new Error(refusal);
}

/** The CLI takes Anthropic's model ids, so Pi's card for the same id supplies the limits. */
function claudeCodeModel(id: string, models: Models): Model<Api> {
  const card = models.getModel("anthropic", id);
  return {
    id,
    name: card?.name ?? id,
    api: CLAUDE_CODE_API,
    provider: CLAUDE_CODE_PROVIDER_ID,
    baseUrl: "",
    reasoning: card?.reasoning ?? true,
    ...(card?.thinkingLevelMap ? { thinkingLevelMap: card.thinkingLevelMap } : {}),
    input: card?.input ?? ["text", "image"],
    // Usage counts against the operator's own Claude plan, so Rakazo prices nothing: zero
    // rates make the usage cost unknown rather than free.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: card?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: card?.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

function stream(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
  return streamClaudeCode(model, context, { ...options, assertAllowed });
}

/**
 * Only the deployment's own default, opted into with host credentials, runs through the CLI. It
 * is never offered in the model catalog, so no one is asked for a Claude key or sign-in.
 */
export function claudeCodeProvider(models: Models): Provider | undefined {
  const deployment = resolveDeploymentModel();
  if (deployment.provider !== CLAUDE_CODE_PROVIDER_ID || !deployment.hostCredentials) {
    return undefined;
  }
  return createProvider({
    id: CLAUDE_CODE_PROVIDER_ID,
    name: "Claude Code",
    auth: {
      apiKey: {
        name: "Claude Code sign-in on this server",
        // The CLI signs its own requests; Rakazo has no credential to resolve.
        resolve: async () => ({ auth: {}, source: "claude auth login" }),
      },
    },
    models: [claudeCodeModel(deployment.model, models)],
    api: { stream, streamSimple: stream },
  });
}

export function registerClaudeCodeProvider(models: MutableModels): MutableModels {
  const provider = claudeCodeProvider(models);
  if (provider) models.setProvider(provider);
  return models;
}
