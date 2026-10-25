/** Keep the credential out of connector configuration; the API encrypts it separately. */
export type SourceAuthentication = "none" | "bearer" | "api_key" | "oauth";

/** The installed-connector provider already supports named credential headers. */
export function sourceCredentialAuth(
  method: Exclude<SourceAuthentication, "oauth">,
  header: string,
) {
  if (method === "none") return { type: "none" as const };
  if (method === "bearer") return { type: "bearer" as const };
  const name = header.trim();
  // Match the backend HTTP header-name policy before sending any credential.
  if (!name || name.length > 120 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
    throw new Error("Enter a valid API key header name");
  }
  if (
    /^(connection|content-length|host|proxy-authorization|proxy-connection|te|trailer|transfer-encoding|upgrade)$/i.test(
      name,
    )
  ) {
    throw new Error("This header cannot be used for authentication");
  }
  return { type: "header" as const, name };
}

/** A generated opaque slug avoids forcing a user-visible name to ASCII. */
export function nativeMcpSlug(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error("Invalid timestamp");
  return `native-mcp-${Math.trunc(timestamp).toString(36)}`;
}
