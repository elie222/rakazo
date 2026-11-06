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

/** Why a name can't be claimed, for each app to word in its own language. */
export type BotEmailNameProblem = "length" | "taken" | "characters";

/** A name the owner typed, ready to claim, or what is wrong with it. */
export function parseBotEmailName(
  raw: string,
): { name: string; problem?: undefined } | { name?: undefined; problem: BotEmailNameProblem } {
  const parsed = BotEmailNameSchema.safeParse(raw);
  if (parsed.success) return { name: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    problem:
      issue?.code === "too_small" || issue?.code === "too_big"
        ? "length"
        : issue?.message === BOT_EMAIL_NAME_TAKEN
          ? "taken"
          : "characters",
  };
}

/** Null when this server receives no email, or for anyone but the bot's owner. */
export const BotEmailAddressSchema = z
  .object({
    domain: z.string(),
    /** Null until the owner claims a name. */
    address: z.string().nullable(),
  })
  .nullable();
export type BotEmailAddress = z.infer<typeof BotEmailAddressSchema>;

/** The addresses of the caller's own bots in this Space; null when this server receives no email. */
export const BotEmailAddressesSchema = z
  .object({
    domain: z.string(),
    addresses: z.array(z.object({ botId: z.string(), botName: z.string(), address: z.string() })),
  })
  .nullable();
export type BotEmailAddresses = z.infer<typeof BotEmailAddressesSchema>;

/**
 * A first address suggestion from a bot's name, such as "research-helper". ASCII only: many mail
 * servers still refuse non-ASCII addresses. Empty when nothing in the name can be kept.
 */
export function suggestedEmailName(botName: string): string {
  return botName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}
