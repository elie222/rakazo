export function accountIdentityFromResponse(
  status: number,
  identity?: unknown,
): string | undefined {
  if (status === 401 || status === 403 || status === 404) return undefined;
  if (status !== 200) throw new Error(`Mailbox profile lookup returned HTTP ${status}`);
  return typeof identity === "string" ? identity.trim().toLowerCase() || undefined : undefined;
}
