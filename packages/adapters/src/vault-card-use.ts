import { BotSecretName, OneTimeCodeTarget } from "@rakazo/contracts";
import type { FleetCardSummary } from "./approval-ask.js";
import type { PurchaseApproval } from "./purchase-gate.js";
import { purchaseCardSummary } from "./purchase-gate.js";

/**
 * A saved card a person approved typing into one checkout: carried in the persisted request, so a
 * replay types exactly that card on exactly that site. `title` is what the approval card showed, and
 * `savedAt` is when the card was last saved, so one replaced while the approval waited is not typed.
 */
export type VaultCardUse = { card: string; site: string; title: string; savedAt: string };

/** A card use as the persisted request holds it, or nothing when it is not one. */
export function vaultCardUseOf(value: unknown): VaultCardUse | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { card, site, title, savedAt } = value as Record<string, unknown>;
  if (
    !BotSecretName.safeParse(card).success ||
    !OneTimeCodeTarget.safeParse({ origin: site }).success ||
    typeof title !== "string" ||
    typeof savedAt !== "string"
  )
    return undefined;
  return { card: card as string, site: new URL(site as string).origin, title, savedAt };
}

/** The site a fill_card step names, reduced to its origin, so a page URL names its site. */
export function cardFillSite(value: unknown): string {
  const text = String(value ?? "").trim();
  return URL.canParse(text) ? new URL(text).origin : text;
}

/**
 * The saved card and checkout a browser_act call types into, from its fill_card steps that name a
 * card. One call types one card on one site, so one approval covers exactly what it shows.
 */
export function requestedCardUse(
  actions: unknown,
): { card: string; site: string } | { error: string } | undefined {
  if (!Array.isArray(actions)) return undefined;
  const uses = actions.flatMap((raw) => {
    const step = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    // As browser_act reads a step: an empty card beside a purchase is no saved card.
    const card = typeof step.card === "string" ? step.card.trim() : "";
    return step.kind === "fill_card" && card ? [{ card, site: cardFillSite(step.site) }] : [];
  });
  const [first] = uses;
  if (!first) return undefined;
  if (!OneTimeCodeTarget.safeParse({ origin: first.site }).success) {
    return { error: "fill_card with a saved card needs site: the checkout page's HTTPS origin." };
  }
  if (uses.some((use) => use.card !== first.card || use.site !== first.site)) {
    return { error: "Type one saved card on one site per browser_act call." };
  }
  return first;
}

/** The approval card for typing a saved card, with the purchase the same call presses, if any. */
export function cardUseSummary(use: VaultCardUse, purchase?: PurchaseApproval): FleetCardSummary {
  const host = new URL(use.site).host;
  const paying = purchase ? purchaseCardSummary(purchase) : undefined;
  return {
    onceOnly: true,
    title: `Pay with ${use.title} on ${host}?`,
    lines: paying?.lines ?? [],
    ...(paying?.receipt ? { receipt: paying.receipt } : {}),
  };
}
