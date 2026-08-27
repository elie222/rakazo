import { createProvider, envApiKeyAuth, type Model, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

// ponytail: fixed env-configured provider for Chris's existing model bridge.
const PROVIDER_ID = "workmate-claude";

function bridgeModels(baseUrl: string): Model<"openai-completions">[] {
  const ids = (process.env.WORKMATE_CLAUDE_MODELS ?? "claude-sonnet-5,claude-opus-5,fable")
    .split(",")
    .map((modelId) => modelId.trim())
    .filter(Boolean);
  return ids.map((id) => ({
    id,
    name: `WorkMate ${id}`,
    api: "openai-completions" as const,
    provider: PROVIDER_ID as Model<"openai-completions">["provider"],
    baseUrl,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  }));
}

export function workmateClaudeProvider(): Provider<"openai-completions"> | undefined {
  const baseUrl = process.env.WORKMATE_CLAUDE_BASE_URL;
  if (!baseUrl) return undefined;
  return createProvider({
    id: PROVIDER_ID,
    name: "WorkMate Claude",
    baseUrl,
    auth: { apiKey: envApiKeyAuth("WorkMate Claude bridge token", ["WORKMATE_CLAUDE_API_KEY"]) },
    models: bridgeModels(baseUrl),
    api: openAICompletionsApi(),
  });
}
