import * as z from "zod";

export const BOT_EMAIL_NAME_TAKEN = "That address isn't available";

/** Role and abuse-desk names (RFC 2142) and names people trust by reflex. */
const RESERVED_BOT_EMAIL_NAMES = new Set([
  "abuse",
  "admin",
  "administrator",
  "billing",
  "help",
  "hostmaster",
  "info",
  "mailer-daemon",
  "no-reply",
  "noc",
  "noreply",
  "postmaster",
  "root",
  "security",
  "support",
  "webmaster",
]);

/** The part of a bot's address before the @, as its owner chose it. */
export const BotEmailNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "Use at least 2 characters")
  .max(64, "Use at most 64 characters")
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, "Use letters, numbers, dots, dashes or underscores")
  .refine((name) => !name.includes(".."), "Use letters, numbers, dots, dashes or underscores")
  .refine((name) => !RESERVED_BOT_EMAIL_NAMES.has(name), BOT_EMAIL_NAME_TAKEN);

/** Null when this server receives no email, or for anyone but the bot's owner. */
export const BotEmailAddressSchema = z
  .object({
    domain: z.string(),
    /** Null until the owner claims a name. */
    address: z.string().nullable(),
  })
  .nullable();
export type BotEmailAddress = z.infer<typeof BotEmailAddressSchema>;
