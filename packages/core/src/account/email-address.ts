/** Mail providers that deliver one mailbox under several domains, mapped to the domain stored. */
const DOMAIN_ALIASES: Record<string, string> = { "googlemail.com": "gmail.com" };

export function canonicalEmailDomain(domain: string): string {
  const lower = domain.trim().toLowerCase();
  return DOMAIN_ALIASES[lower] ?? lower;
}

/** Every spelling one mailbox may be stored under, canonical first. */
export function emailSpellings(email: string): string[] {
  const canonical = canonicalEmail(email);
  const at = canonical.lastIndexOf("@");
  if (at < 0) return [canonical];
  const local = canonical.slice(0, at);
  const domain = canonical.slice(at + 1);
  const aliases = Object.keys(DOMAIN_ALIASES).filter((alias) => DOMAIN_ALIASES[alias] === domain);
  return [canonical, ...aliases.map((alias) => `${local}@${alias}`)];
}

/** The one form an address is stored and looked up in, so one mailbox is one account. */
export function canonicalEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at < 0) return lower;
  return `${lower.slice(0, at)}@${canonicalEmailDomain(lower.slice(at + 1))}`;
}
