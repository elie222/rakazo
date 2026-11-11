import type { BotSecretAuthType, BotSecretMetadata, ContactFields } from "./bot-secrets.js";
import { cardExpiry, commandVariableName, VAULT_ALSO_ON_LIMIT } from "./bot-secrets.js";

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

/**
 * The other sites typed for a login, or why they can't be saved: too many, or one that isn't an
 * HTTPS address a page can be on (a wildcard never is). The server keeps only each site's origin.
 */
export function typedOtherSites(text: string): string[] | "too_many" | "not_https" {
  const sites = text.split(/[\s,]+/).filter(Boolean);
  if (sites.length > VAULT_ALSO_ON_LIMIT) return "too_many";
  const https = (url: URL) =>
    url.protocol === "https:" && !url.username && !url.password && !url.hostname.includes("*");
  return sites.every((site) => URL.canParse(site) && https(new URL(site))) ? sites : "not_https";
}

/** Whether a value being saved is a login carrying an authenticator key. */
export function hasAuthenticatorKey(value: string | undefined): boolean {
  try {
    return Boolean(value && JSON.parse(value)?.otp);
  } catch {
    return false;
  }
}

// A contact isn't secret, so it has no Allow or Block.
export function hasVaultAccess(kind: VaultKind): boolean {
  return kind !== "contact";
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
