import type { BotSecretAuthType, BotSecretMetadata, ContactFields } from "./bot-secrets.js";
import { cardExpiry, commandVariableName } from "./bot-secrets.js";

/**
 * What people add and filter by in the vault, on every surface. API credentials of every auth type
 * are one "API key"; a command variable is a "variable".
 */
export type VaultKind = "login" | "card" | "contact" | "api_key" | "variable";
export const VAULT_KINDS: readonly VaultKind[] = [
  "login",
  "card",
  "contact",
  "api_key",
  "variable",
];

export function vaultKind(type: BotSecretAuthType): VaultKind {
  if (type === "login" || type === "card" || type === "contact") return type;
  return type === "command" ? "variable" : "api_key";
}

function host(origin: string): string {
  return URL.canParse(origin) ? new URL(origin).host.replace(/^www\./, "") : origin;
}

/**
 * The line under an item's title in a vault list: what tells two of a kind apart at a glance.
 * Empty for an item whose settings can't be read. Each app passes its own words.
 */
export function vaultItemSubtitle(
  item: Pick<BotSecretMetadata, "name" | "origin" | "auth" | "title" | "note" | "preview">,
  words: { apiKey: string; expires: (date: string) => string },
): string {
  if (!item.auth) return "";
  const { preview } = item;
  const site = host(item.origin);
  // An item without its own title is already titled by its site, so the site isn't said twice.
  const ownSite = item.title === site ? undefined : site;
  const line = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" · ");
  switch (vaultKind(item.auth.type)) {
    case "login":
      return line(preview?.username, ownSite);
    case "card":
      return line(
        preview?.card ? words.expires(cardExpiry(preview.card)) : undefined,
        item.note || undefined,
      );
    case "contact": {
      const contact: Partial<ContactFields> = preview?.contact ?? {};
      const address = [contact.line1, contact.city].filter(Boolean).join(", ");
      return [
        contact.name && contact.name !== item.title ? contact.name : undefined,
        address || undefined,
        contact.phone,
        contact.email,
      ]
        .filter(Boolean)
        .slice(0, 2)
        .join(" · ");
    }
    case "api_key":
      return line(words.apiKey, ownSite);
    case "variable":
      return `$${commandVariableName(item.name)}`;
  }
}
