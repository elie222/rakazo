import type { AcpAgentDescriptor } from "./acp-agent.js";
import type { AcpConnection } from "./acp-connection.js";

type Update = Record<string, unknown>;

const EFFORT_SUFFIXES = ["low", "medium", "high", "xhigh"] as const;

const SUFFIX_THINKING_CANDIDATES: Record<string, readonly string[]> = {
  minimal: ["minimal", "low"],
  low: ["low", "minimal"],
  medium: ["medium", "low", "high"],
  high: ["high", "medium", "xhigh"],
  xhigh: ["xhigh", "high", "max"],
  max: ["max", "xhigh", "high"],
};

const THINKING_TO_ACP_CANDIDATES: Record<string, readonly string[]> = {
  minimal: ["minimal", "low"],
  low: ["low", "minimal", "medium"],
  medium: ["medium", "low", "high"],
  high: ["high", "medium", "xhigh"],
  xhigh: ["xhigh", "high", "max"],
  max: ["max", "xhigh", "high"],
};

/** Chooses the deployment model when the CLI offers a model choice for the session. */
export async function selectModel(
  agent: AcpConnection,
  sessionId: string,
  opened: Update | undefined,
  modelId: string,
  requestedThinkingLevel: string | null | undefined,
  descriptor: AcpAgentDescriptor,
  step: <T>(work: Promise<T>) => Promise<T>,
): Promise<{ inferredEffort?: string; configOptions: unknown }> {
  const options = Array.isArray(opened?.configOptions) ? (opened.configOptions as Update[]) : [];
  const choice = options.find((option) => option.category === "model" || option.id === "model");
  // Running on whatever the CLI defaults to would spend the plan on a model nobody chose.
  if (!choice) throw new Error(`${descriptor.label} offers no model choice for its sessions.`);
  const hasThoughtLevelOption = options.some(
    (option) => option.category === "thought_level" || option.id === "thought_level",
  );
  const values = flattenValues(choice.options);
  let targetModelId = modelId;
  let inferredEffort: string | undefined;

  // When the ACP server encodes thinking effort as suffixed model ids (such as
  // `gemini-4-neon-high` / `gemini-4-neon-low`) instead of a separate `thought_level` option,
  // prefer the matching effort-suffixed model id for the requested thinking level.
  if (!hasThoughtLevelOption && requestedThinkingLevel && requestedThinkingLevel !== "off") {
    const candidates = SUFFIX_THINKING_CANDIDATES[requestedThinkingLevel] ?? [
      requestedThinkingLevel,
    ];
    const suffixed = candidates
      .map((candidate) => `${modelId}-${candidate}`)
      .find((candidateId) => values.includes(candidateId));
    if (suffixed) {
      targetModelId = suffixed;
    }
  }

  if (values.length && !values.includes(targetModelId)) {
    // Support legacy suffixed model ids such as `gemini-4-neon-high` when the ACP server exposes
    // base models paired with a separate `thought_level` option.
    const matchedSuffix = EFFORT_SUFFIXES.find(
      (suffix) =>
        targetModelId.endsWith(`-${suffix}`) &&
        values.includes(targetModelId.slice(0, -(suffix.length + 1))),
    );
    if (matchedSuffix) {
      targetModelId = targetModelId.slice(0, -(matchedSuffix.length + 1));
      inferredEffort = matchedSuffix;
    } else {
      throw new Error(
        `${descriptor.label} on this server has no model "${modelId}". Set PI_DEFAULT_MODEL to one of: ${values.slice(0, 20).join(", ")}${values.length > 20 ? `, and ${values.length - 20} more the CLI lists` : ""}.`,
      );
    }
  }
  if (choice.currentValue === targetModelId) {
    return { inferredEffort, configOptions: opened?.configOptions };
  }
  const updated = await step(
    agent.request<Update>("session/set_config_option", {
      sessionId,
      configId: choice.id,
      value: targetModelId,
    }),
  );
  return {
    inferredEffort,
    configOptions: Array.isArray(updated?.configOptions)
      ? updated.configOptions
      : opened?.configOptions,
  };
}

/** Applies the requested thinking level when the ACP server exposes a `thought_level` option. */
export async function selectThoughtLevel(
  agent: AcpConnection,
  sessionId: string,
  rawConfigOptions: unknown,
  requestedLevel: string | null | undefined,
  step: <T>(work: Promise<T>) => Promise<T>,
): Promise<void> {
  if (!requestedLevel || requestedLevel === "off") return;
  const options = Array.isArray(rawConfigOptions) ? (rawConfigOptions as Update[]) : [];
  const choice = options.find(
    (option) => option.category === "thought_level" || option.id === "thought_level",
  );
  if (!choice) return;
  const values = flattenValues(choice.options);
  const candidates = THINKING_TO_ACP_CANDIDATES[requestedLevel] ?? [requestedLevel];
  const resolved = values.length
    ? candidates.find((candidate) => values.includes(candidate))
    : requestedLevel;
  if (!resolved || choice.currentValue === resolved) return;
  await step(
    agent.request("session/set_config_option", {
      sessionId,
      configId: choice.id,
      value: resolved,
    }),
  );
}

function flattenValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((option: Update) =>
    Array.isArray(option?.options)
      ? flattenValues(option.options)
      : typeof option?.value === "string"
        ? [option.value]
        : [],
  );
}
