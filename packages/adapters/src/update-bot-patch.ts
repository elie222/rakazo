import { BOT_DESCRIPTION_MAX_LENGTH, BOT_NAME_MAX_LENGTH } from "@rakazo/contracts";

export type UpdateBotPatch = {
  name?: string;
  description?: string;
  color?: string;
  notifyOnFinish?: boolean;
  dailyCheckIns?: boolean;
};

function hasUpdateBotAvatarArgs(args: Record<string, unknown>): boolean {
  return (
    args.color !== undefined || args.artifact_id !== undefined || args.use_attached_image === true
  );
}

export function parseUpdateBotPatch(
  args: Record<string, unknown>,
): { error: string } | { patch: UpdateBotPatch } {
  const patch: UpdateBotPatch = {};
  if (args.name !== undefined) patch.name = String(args.name);
  if (args.description !== undefined) patch.description = String(args.description);
  if (args.dailyCheckIns !== undefined) {
    if (typeof args.dailyCheckIns !== "boolean")
      return { error: "dailyCheckIns must be true or false." };
    patch.dailyCheckIns = args.dailyCheckIns;
  }
  const notifyRaw = args.notifyOnFinish !== undefined ? args.notifyOnFinish : args.notify_on_finish;
  if (notifyRaw !== undefined) {
    if (typeof notifyRaw !== "boolean") {
      return { error: "notifyOnFinish must be true or false." };
    }
    patch.notifyOnFinish = notifyRaw;
  }
  if (Object.keys(patch).length === 0 && !hasUpdateBotAvatarArgs(args)) {
    return {
      error:
        "Provide at least one of name, description, notifyOnFinish, color, artifact_id, or use_attached_image.",
    };
  }
  if (patch.name !== undefined) {
    const nextName = patch.name.trim();
    if (!nextName) return { error: "name cannot be empty." };
    if (nextName.length > BOT_NAME_MAX_LENGTH) {
      return { error: `name must be at most ${BOT_NAME_MAX_LENGTH} characters.` };
    }
    patch.name = nextName;
  }
  if (patch.description !== undefined) {
    const nextDescription = patch.description.trim();
    if (nextDescription.length > BOT_DESCRIPTION_MAX_LENGTH) {
      return { error: `description must be at most ${BOT_DESCRIPTION_MAX_LENGTH} characters.` };
    }
    patch.description = nextDescription;
  }
  return { patch };
}

/** The bot's current values that an own `update_bot` call can repeat. */
export type OwnBotCurrentValues = {
  name: string;
  description: string | null;
  instructions: string;
  color: string;
  notifyOnFinish: boolean;
  dailyCheckIns: boolean;
  modelId: string | null;
  thinkingLevel: string | null;
  autoSpeak: boolean;
  voiceId: string | null;
};

/**
 * Some models fill in every field of a tool call, repeating current values and `false` for
 * switches they mean to leave alone. A value the bot already has is not a change, so drop it:
 * otherwise a plain read looks like a write and is refused or held.
 */
export function dropUnchangedOwnBotArgs(
  args: Record<string, unknown>,
  current: OwnBotCurrentValues,
  /** The model and thinking this run is using, which a bot on the defaults reports as its own. */
  running: { modelId?: string | null; thinkingLevel?: string | null } = {},
): Record<string, unknown> {
  const modelId = current.modelId ?? running.modelId ?? undefined;
  const same: Record<string, unknown> = {
    name: current.name,
    description: current.description ?? "",
    instructions: current.instructions,
    color: current.color,
    notifyOnFinish: current.notifyOnFinish,
    notify_on_finish: current.notifyOnFinish,
    dailyCheckIns: current.dailyCheckIns,
    model: modelId,
    thinkingLevel: current.thinkingLevel ?? running.thinkingLevel ?? "default",
    readAloud: current.autoSpeak,
    voice: current.voiceId ?? "default",
    use_attached_image: false,
    // Reading from the start is the default, not a request to page.
    instructions_offset: 0,
    instructionsOffset: 0,
  };
  const kept: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(args)) {
    // Switches sometimes arrive as the text "true" or "false".
    const value =
      typeof same[key] === "boolean" && (raw === "true" || raw === "false") ? raw === "true" : raw;
    const repeated =
      key in same &&
      same[key] !== undefined &&
      (typeof value === "string" && typeof same[key] === "string"
        ? value.trim() === (same[key] as string).trim() ||
          // A model may be named with its provider, e.g. "openai-compatible/gpt-fixture".
          (key === "model" && value.trim().endsWith(`/${same[key] as string}`))
        : value === same[key]);
    if (!repeated) kept[key] = value;
  }
  return kept;
}

/** Providers send omitted optional fields as null or blank; only anything else counts as given. */
export function argumentGiven(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim().length > 0;
}
