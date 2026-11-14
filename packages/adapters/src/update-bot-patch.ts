import { BOT_DESCRIPTION_MAX_LENGTH, BOT_NAME_MAX_LENGTH } from "@rakazo/contracts";

/**
 * `update_bot` fields that change a setting. A call applies only those it names in `change`:
 * some models fill in every field, with `false` or "off" for the ones they mean to leave alone,
 * so a call meant as a read switched settings off. Without `change` the call is a read.
 * `ownerOnly` marks what changes what the bot runs on or how it speaks, which only the owner's
 * own chat may set.
 */
const UPDATE_BOT_SETTINGS = {
  name: {},
  description: {},
  instructions: {},
  color: {},
  artifact_id: {},
  use_attached_image: {},
  notifyOnFinish: {},
  dailyCheckIns: {},
  model: { ownerOnly: true },
  thinkingLevel: { ownerOnly: true },
  readAloud: { ownerOnly: true },
  voice: { ownerOnly: true },
} as const satisfies Record<string, { ownerOnly?: true }>;

type UpdateBotSettingField = keyof typeof UPDATE_BOT_SETTINGS;

export const UPDATE_BOT_SETTING_FIELDS = Object.keys(
  UPDATE_BOT_SETTINGS,
) as readonly UpdateBotSettingField[];

/** Settings only the owner's own chat may change: the bot's model, thinking, voice and read-aloud. */
export const UPDATE_BOT_OWNER_ONLY_FIELDS: readonly UpdateBotSettingField[] =
  UPDATE_BOT_SETTING_FIELDS.filter((field) => "ownerOnly" in UPDATE_BOT_SETTINGS[field]);

/** Every argument that sets an `update_bot` setting, the `notify_on_finish` alias included. */
export const UPDATE_BOT_SETTING_KEYS: ReadonlySet<string> = new Set([
  ...UPDATE_BOT_SETTING_FIELDS,
  "notify_on_finish",
]);

/** Whether `key: value` sets something; no picture attached is the default, not a setting. */
function setsSetting(key: string, value: unknown): boolean {
  return (
    UPDATE_BOT_SETTING_KEYS.has(key) &&
    argumentGiven(value) &&
    !(key === "use_attached_image" && value === false)
  );
}

/** The settings an `update_bot` call's arguments set; none means it only reads. */
export function updateBotSettingsGiven(args: Record<string, unknown>): string[] {
  return Object.keys(args).filter((key) => setsSetting(key, args[key]));
}

/**
 * Splits an `update_bot` call into the arguments it applies, with the settings it names in
 * `change`, and the settings it only filled in, which its result names as not applied.
 */
export function splitUpdateBotChange(args: Record<string, unknown>): {
  args: Record<string, unknown>;
  unlisted: Record<string, unknown> | undefined;
} {
  const { change, ...rest } = args;
  // Some models send a single field as a string instead of a one-item list.
  const names = Array.isArray(change) ? change : typeof change === "string" ? [change] : [];
  const listed = new Set(names.map(String));
  if (listed.has("notifyOnFinish") || listed.has("notify_on_finish")) {
    listed.add("notifyOnFinish");
    listed.add("notify_on_finish");
  }
  const kept: Record<string, unknown> = {};
  const unlisted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (!UPDATE_BOT_SETTING_KEYS.has(key) || listed.has(key)) kept[key] = value;
    else if (setsSetting(key, value)) unlisted[key] = value;
  }
  return { args: kept, unlisted: Object.keys(unlisted).length ? unlisted : undefined };
}

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
    use_attached_image: [false],
    // Reading from the start is the default, not a request to page.
    instructions_offset: [0],
    instructionsOffset: [0],
  };
  const kept: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(args)) {
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

/**
 * The fields a call did not apply, bounded so a read keeps its own size budget: a paged read
 * never writes, a field missing from `change` is only filled in, and another bot's owner-only
 * settings change only in Settings.
 */
export function ignoredFieldsNote(
  fields: Record<string, unknown>,
  reason: "paged_read" | "unlisted" | "owner_only" = "paged_read",
): string | undefined {
  const given = Object.entries(fields).filter(([, value]) => argumentGiven(value));
  if (!given.length) return undefined;
  const shown = given.slice(0, IGNORED_FIELDS_SHOWN).map(([key, value]) => {
    const json = JSON.stringify(value) ?? "";
    return `${key}=${json.length > IGNORED_VALUE_PREVIEW ? `${json.slice(0, IGNORED_VALUE_PREVIEW)}…` : json}`;
  });
  const more = given.length - shown.length;
  const list = `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  if (reason === "paged_read")
    return `This was a read, so these were not applied: ${list}. To change one, call update_bot with just that field, listed in change, and no instructions_offset.`;
  if (reason === "owner_only")
    return `Another bot's model, thinking, voice and read-aloud change only in its Settings, so these were not applied: ${list}.`;
  return `These were not listed in change, so they were not applied: ${list}. To change one, list it in change.`;
}

/** What an `update_bot` call's result says it did not apply, if anything. */
export function notAppliedNote(fields: {
  unlistedFields?: Record<string, unknown>;
  ownerOnlyFields?: Record<string, unknown>;
}): string | undefined {
  const notes = [
    fields.unlistedFields && ignoredFieldsNote(fields.unlistedFields, "unlisted"),
    fields.ownerOnlyFields && ignoredFieldsNote(fields.ownerOnlyFields, "owner_only"),
  ].filter(Boolean);
  return notes.length ? notes.join(" ") : undefined;
}

/** Providers send omitted optional fields as null or blank; only anything else counts as given. */
export function argumentGiven(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim().length > 0;
}
