/** Mail providers that deliver one mailbox under several domains, mapped to the domain stored. */
const DOMAIN_ALIASES: Record<string, string> = { "googlemail.com": "gmail.com" };

export function canonicalEmailDomain(domain: string): string {
  const lower = domain.trim().toLowerCase();
  return DOMAIN_ALIASES[lower] ?? lower;
}

/** The one form an address is stored and looked up in, so one mailbox is one account. */
export function canonicalEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at < 0) return lower;
  return `${lower.slice(0, at)}@${canonicalEmailDomain(lower.slice(at + 1))}`;
}
