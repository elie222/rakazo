import * as z from "zod";

/**
 * What a page version may ask its host for beyond showing itself and saving reader state. The
 * server derives a version's abilities from its source, so a bot cannot claim fewer than it uses.
 */
export const PAGE_ABILITIES = ["ask", "notify"] as const;
export const PageAbilitySchema = z.enum(PAGE_ABILITIES);
export type PageAbility = z.infer<typeof PageAbilitySchema>;

export const PageAbilitiesSchema = z
  .array(PageAbilitySchema)
  .max(PAGE_ABILITIES.length)
  .refine((abilities) => new Set(abilities).size === abilities.length, "Abilities repeat");

/** A stored list of abilities, keeping only the ones this release knows. */
export function knownPageAbilities(values: readonly string[]): PageAbility[] {
  return PAGE_ABILITIES.filter((ability) => values.includes(ability));
}

/** The most a page may ask its bot in one question. */
export const PAGE_ASK_MAX_LENGTH = 2_000;
/** The most of an answer a page receives. */
export const PAGE_ANSWER_MAX_LENGTH = 20_000;

export const PageAskInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(PAGE_ASK_MAX_LENGTH),
  /** Makes a retried request send the question once. */
  clientNonce: z.string().min(8).max(100),
});
export type PageAskInput = z.infer<typeof PageAskInputSchema>;

/** `working` repeats while the bot runs, so a waiting client knows the request is alive. */
export const PageAskEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("working") }),
  z.strictObject({ kind: z.literal("answer"), text: z.string().max(PAGE_ANSWER_MAX_LENGTH) }),
  z.strictObject({ kind: z.literal("failed"), message: z.string().max(500) }),
]);
export type PageAskEvent = z.infer<typeof PageAskEventSchema>;

export const PAGE_NOTIFY_TITLE_MAX_LENGTH = 120;
export const PAGE_NOTIFY_BODY_MAX_LENGTH = 400;
