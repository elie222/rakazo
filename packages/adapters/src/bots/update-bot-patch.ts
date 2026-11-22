import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  ComputerModeSchema,
  DisabledBuiltinToolsSchema,
  UpdateBotInput,
} from "@rakazo/contracts";
import { argumentGiven } from "@rakazo/core";
import * as z from "zod";

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

/**
 * The `update_bot` fields that change how a bot works, as the owner's settings do. Tools are only
 * ever turned off here: turning one back on, like raising any permission, stays the owner's.
 */
export const BOT_SETTING_ARGS = [
  "replyMode",
  "teamChatAmbientEnabled",
  "teamChatRules",
  "memoryScope",
  "disableTools",
] as const;

/** The settings an `update_bot` call changes; `disableTools` holds only tools not yet off. */
export type BotSettingsPatch = Pick<
  UpdateBotInput,
  "replyMode" | "teamChatAmbientEnabled" | "teamChatRules" | "memoryScope"
> & { disableTools?: string[] };

/** What an approved `update_bot` on another bot applies besides its profile, as stored for replay. */
export const ChildBotSettingsSchema = z
  .object({
    ...UpdateBotInput.shape,
    disableTools: DisabledBuiltinToolsSchema,
    computerMode: ComputerModeSchema,
  })
  .pick({
    replyMode: true,
    teamChatAmbientEnabled: true,
    teamChatRules: true,
    memoryScope: true,
    disableTools: true,
    autoSpeak: true,
    voiceId: true,
    computerMode: true,
  })
  .partial()
  .strict();
export type ChildBotSettings = z.infer<typeof ChildBotSettingsSchema>;

/** The settings among `args`, checked as the settings API checks them. */
export function parseBotSettingsPatch(
  args: Record<string, unknown>,
  bot: { id: string; disabledBuiltinTools: readonly string[] },
): { error: string } | { patch: BotSettingsPatch } {
  const { disableTools } = args;
  if (argumentGiven(disableTools) && !Array.isArray(disableTools))
    return { error: "disableTools must be a list of tool names." };
  const added = Array.isArray(disableTools)
    ? [
        ...new Set(disableTools.map((name) => (typeof name === "string" ? name.trim() : name))),
      ].filter((name) => !bot.disabledBuiltinTools.includes(name))
    : [];
  const given = (key: string) => (argumentGiven(args[key]) ? args[key] : undefined);
  const parsed = UpdateBotInput.safeParse({
    botId: bot.id,
    replyMode: given("replyMode"),
    teamChatAmbientEnabled: given("teamChatAmbientEnabled"),
    teamChatRules: given("teamChatRules"),
    memoryScope: given("memoryScope"),
    disabledBuiltinTools: added.length ? added : undefined,
  });
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const field = issue?.path[0] === "disabledBuiltinTools" ? "disableTools" : issue?.path[0];
    return { error: `${String(field ?? "settings")}: ${issue?.message ?? "invalid"}` };
  }
  const { botId: _botId, disabledBuiltinTools, ...data } = parsed.data;
  const patch: BotSettingsPatch = Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
  if (disabledBuiltinTools?.length) patch.disableTools = disabledBuiltinTools;
  return { patch };
}

/**
 * The bot row update for a settings patch. Tools are appended in the same statement, so a list
 * the owner changes meanwhile is kept rather than overwritten.
 */
export function botSettingsData({
  disableTools,
  ...settings
}: Omit<ChildBotSettings, "computerMode">) {
  return {
    ...settings,
    ...(disableTools?.length ? { disabledBuiltinTools: { push: disableTools } } : {}),
  };
}

/** The bot's current values that an own `update_bot` call can repeat. */
export type OwnBotCurrentValues = {
  name: string;
  description: string | null;
  instructions: string;
  color: string;
  notifyOnFinish: boolean;
  dailyCheckIns: boolean;
  thinkingLevel: string | null;
  autoSpeak: boolean;
  voiceId: string | null;
  replyMode: string;
  teamChatAmbientEnabled: boolean;
  teamChatRules: string;
  memoryScope: string | null;
  disabledBuiltinTools: string[];
};

/**
 * Some models fill in every field of a tool call, repeating current values and `false` for
 * switches they mean to leave alone. A value the bot already has is not a change, so drop it:
 * otherwise a plain read looks like a write and is refused or held.
 */
export function dropUnchangedOwnBotArgs(
  args: Record<string, unknown>,
  current: OwnBotCurrentValues,
  /** Every way the model the bot runs on is written: its id, provider/id and its read label. */
  currentModelNames: string[] = [],
  /** The thinking level this run uses, which a bot on the default level reports as its own. */
  runningThinkingLevel?: string | null,
): Record<string, unknown> {
  const same: Record<string, unknown[]> = {
    name: [current.name],
    description: [current.description ?? ""],
    instructions: [current.instructions],
    color: [current.color],
    notifyOnFinish: [current.notifyOnFinish],
    notify_on_finish: [current.notifyOnFinish],
    dailyCheckIns: [current.dailyCheckIns],
    model: currentModelNames.map((name) => name.toLowerCase()),
    thinkingLevel: current.thinkingLevel
      ? [current.thinkingLevel]
      : ["default", ...(runningThinkingLevel ? [runningThinkingLevel] : [])],
    readAloud: [current.autoSpeak],
    voice: [current.voiceId ?? "default"],
    replyMode: [current.replyMode],
    teamChatAmbientEnabled: [current.teamChatAmbientEnabled],
    teamChatRules: [current.teamChatRules],
    memoryScope: [current.memoryScope ?? "default"],
    use_attached_image: [false],
    // Reading from the start is the default, not a request to page.
    instructions_offset: [0],
    instructionsOffset: [0],
  };
  const kept: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(args)) {
    if (
      key === "disableTools" &&
      Array.isArray(raw) &&
      raw.every((name) => current.disabledBuiltinTools.includes(name))
    )
      continue;
    const values = same[key] ?? [];
    // Switches sometimes arrive as the text "true" or "false".
    const value =
      typeof values[0] === "boolean" && (raw === "true" || raw === "false") ? raw === "true" : raw;
    const compared =
      typeof value !== "string"
        ? value
        : key === "model"
          ? value.trim().toLowerCase()
          : value.trim();
    const repeated = values.some((known) =>
      typeof known === "string" ? known.trim() === compared : known === compared,
    );
    if (!repeated) kept[key] = value;
  }
  return kept;
}

/** How many ignored fields a paged read names, and how much of each value it shows. */
const IGNORED_FIELDS_SHOWN = 8;
const IGNORED_VALUE_PREVIEW = 60;

/** The fields a paged read did not apply, bounded so the read keeps its own size budget. */
export function ignoredFieldsNote(fields: Record<string, unknown>): string | undefined {
  const given = Object.entries(fields).filter(([, value]) => argumentGiven(value));
  if (!given.length) return undefined;
  const shown = given.slice(0, IGNORED_FIELDS_SHOWN).map(([key, value]) => {
    const json = JSON.stringify(value) ?? "";
    return `${key}=${json.length > IGNORED_VALUE_PREVIEW ? `${json.slice(0, IGNORED_VALUE_PREVIEW)}…` : json}`;
  });
  const more = given.length - shown.length;
  return `This was a read, so these were not applied: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}. To change one, call update_bot with just that field and no instructions_offset.`;
}

export { argumentGiven };
