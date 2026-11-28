import * as z from "zod";

/** Null leaves the choice with the device, including its existing saved preference. */
export const ChatPreferencesSchema = z.object({
  composerModelPicker: z.boolean().nullable().default(null),
  streamReplies: z.boolean().nullable().default(null),
});
export type ChatPreferences = z.infer<typeof ChatPreferencesSchema>;

export const ChatPreferencesPatchSchema = z.strictObject({
  composerModelPicker: z.boolean().optional(),
  streamReplies: z.boolean().optional(),
});
export type ChatPreferencesPatch = z.infer<typeof ChatPreferencesPatchSchema>;

export const MAX_STARRED_MODELS = 100;

export const StarredModelKeySchema = z
  .string()
  .min(3)
  .max(256)
  .refine(
    (value) => {
      const separator = value.indexOf("::");
      return separator > 0 && separator + 2 < value.length;
    },
    { message: "Invalid model key" },
  );

export const StarredModelToggleSchema = z.strictObject({
  key: StarredModelKeySchema,
  starred: z.boolean(),
});
export type StarredModelToggle = z.infer<typeof StarredModelToggleSchema>;

export const AccountChatPreferencesSchema = ChatPreferencesSchema.extend({
  // Older servers omit these fields, so clients handle their absence.
  notificationSounds: z.boolean().optional(),
  starredModels: z.array(z.string()).optional(),
});

export const AccountChatPreferencesPatchSchema = ChatPreferencesPatchSchema.extend({
  notificationSounds: z.boolean().optional(),
  starredModels: z.array(StarredModelKeySchema).max(MAX_STARRED_MODELS).optional(),
  starredModelToggle: StarredModelToggleSchema.optional(),
}).refine((patch) => patch.starredModels === undefined || patch.starredModelToggle === undefined, {
  message: "Specify either starredModels or starredModelToggle, not both",
});
export type AccountChatPreferencesPatch = z.infer<typeof AccountChatPreferencesPatchSchema>;

/**
 * Deprecated account-level setting. Per-bot rendering uses avatarSet. Kept for older
 * app versions; the legacy settings endpoint still always reports "organic".
 */
export const AvatarStyleSchema = z.enum(["robot", "organic"]);

/** True for an IANA timezone this runtime can format in, such as "Pacific/Auckland". */
export function isValidTimeZone(value: string): boolean {
  // Intl also accepts fixed offsets, which are not IANA timezone names.
  if (/^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { message: "Unknown timezone" });

/** An app language code, such as "es", "pt-BR" or "zh-TW". */
export const AppLocaleSchema = z.enum([
  "en",
  "de",
  "ko",
  "tr",
  "hi",
  "pt-BR",
  "zh-CN",
  "zh-TW",
  "es",
  "ru",
  "fr",
  "he",
  "nl",
  "ja",
  "pl",
  "th",
]);
