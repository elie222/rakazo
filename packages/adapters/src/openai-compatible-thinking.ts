import type { Model } from "@earendil-works/pi-ai";

/** Exact server model IDs; compatibility is an operator choice, never inferred from a name. */
export function qwenModelIds(): string[] {
  return [
    ...new Set(
      (process.env.RAKAZO_OPENAI_COMPAT_QWEN_MODELS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
}

export function openAiCompatibleThinking(
  modelId: string,
): Pick<Model<"openai-completions">, "reasoning" | "compat" | "thinkingLevelMap"> {
  const compat = { supportsDeveloperRole: false, supportsReasoningEffort: false };
  if (!qwenModelIds().includes(modelId)) return { reasoning: false, compat };
  return {
    reasoning: true,
    compat: {
      ...compat,
      thinkingFormat: "chat-template",
      chatTemplateKwargs: {
        enable_thinking: { $var: "thinking.enabled" },
        reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
        preserve_thinking: true,
      },
    },
    // Qwen effort templates accept low, medium, and xhigh. Older Qwen
    // templates use only enable_thinking and ignore the effort value.
    thinkingLevelMap: {
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "xhigh",
    },
  };
}
