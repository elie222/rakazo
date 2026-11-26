export const mailboxProfileUrl = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

export function mailboxProfileIdentity(status: number, data?: unknown): string | undefined {
  if (status === 401 || status === 403 || status === 404) return undefined;
  if (status !== 200) throw new Error(`Mailbox profile lookup returned HTTP ${status}`);
  if (!data || typeof data !== "object" || !("emailAddress" in data)) return undefined;
  const address = data.emailAddress;
  return typeof address === "string" ? address.trim().toLowerCase() || undefined : undefined;
}
