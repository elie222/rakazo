import type { AgentRunModel, AgentRunRequest, ModelEscalation } from "@rakazo/adapter-kit";
import type { FallbackStreamState } from "./pi-runtime-fallback.js";
import type { RuntimeModelTarget } from "./pi-runtime-models.js";
import {
  cardOutputCeiling,
  modelForCompletion,
  modelTargetKey,
  resolveRuntimeModel,
  sameModelTarget,
} from "./pi-runtime-models.js";

const MAX_RESULT_TEXT = 20_000;

/** A tool result's text blocks, joined, for an escalation hook to read. Long results are cut. */
export function toolResultText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      text += String((block as { text?: unknown }).text ?? "");
      if (text.length > MAX_RESULT_TEXT) return text.slice(0, MAX_RESULT_TEXT);
    }
  }
  return text;
}

/** The model an escalation step names, ready to stream to, or undefined when it cannot be loaded. */
export async function escalationTarget(
  escalation: ModelEscalation,
  wanted: Pick<AgentRunModel, "provider" | "id">,
): Promise<RuntimeModelTarget | undefined> {
  const config = await escalation.resolve(wanted.provider, wanted.id);
  if (config.provider !== wanted.provider || config.id !== wanted.id) return undefined;
  const resolved = resolveRuntimeModel(config);
  if (
    !resolved.model ||
    resolved.model.provider !== config.provider ||
    resolved.model.id !== config.id
  )
    return undefined;
  return {
    config,
    models: resolved.models,
    model: modelForCompletion(resolved.model, config.maxTokens),
    cardMaxTokens: cardOutputCeiling(resolved.model),
    apiKey: resolved.apiKey,
    credentials: resolved.credentials,
  };
}

/**
 * After a move, a failing model falls back first to the model the run left, then to the backups
 * the run has not used yet. Backups already tried are not tried again.
 */
export function fallBackToLeftModel(state: FallbackStreamState, left: RuntimeModelTarget): void {
  const remaining = (state.request.fallbackModels ?? []).slice(state.nextIndex);
  const resolveBackup = state.request.resolveFallbackModel;
  const leftChoice = {
    provider: left.config.provider,
    id: left.config.id,
    connectionId: left.config.connectionId,
  };
  state.request = {
    ...state.request,
    fallbackModels: [leftChoice, ...remaining],
    resolveFallbackModel: async (provider, modelId, connectionId) => {
      if (sameModelTarget({ provider, id: modelId, connectionId }, left.config)) return left.config;
      if (resolveBackup) return resolveBackup(provider, modelId, connectionId);
      // Without a resolver a backup is used as given, as the fallback stream does.
      const given = remaining.find((choice) =>
        sameModelTarget(choice, { provider, id: modelId, connectionId }),
      );
      if (!given) throw new Error("Backup model is not selected");
      return given as AgentRunRequest["model"];
    },
  };
  state.nextIndex = 0;
  state.attempted.delete(modelTargetKey(left.config));
}
