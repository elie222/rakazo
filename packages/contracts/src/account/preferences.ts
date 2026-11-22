import * as z from "zod";

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

const QuietHourSchema = z.number().int().min(0).max(23);

/**
 * Every day from `start` to `end`, whole hours in the person's timezone, news in their chats
 * doesn't notify them; what needs them still does. An `end` before `start` runs past midnight.
 */
export const QuietHoursSchema = z
  .object({ start: QuietHourSchema, end: QuietHourSchema })
  .refine((hours) => hours.start !== hours.end, { message: "Quiet hours need an end" });
export type QuietHours = z.infer<typeof QuietHoursSchema>;

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
