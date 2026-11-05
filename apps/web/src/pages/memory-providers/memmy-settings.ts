/** Example for the empty URL field. Not a connection default. */
export const MEMMY_ENDPOINT_PLACEHOLDER = "http://127.0.0.1:18960";

/**
 * The service URL must be configured: this provider is self-hosted, so there is no
 * hosted default to fall back to. URL validity stays on the backend, which classifies
 * the endpoint before decrypting the token.
 */
export function memmyEndpointError(endpoint: string): "required" | null {
  return endpoint.trim() ? null : "required";
}

/**
 * The token is the memory service's own service token. Model selection is deliberately
 * absent: which models summarize, evolve or embed belongs to the memory service's
 * settings, not to this connection.
 */
export function memmyConnectionDraft(input: {
  endpoint: string;
  token: string;
}):
  | { ok: true; draft: { settings: Record<string, string>; credentials: Record<string, string> } }
  | { ok: false; error: "required" } {
  const error = memmyEndpointError(input.endpoint);
  if (error) return { ok: false, error };
  return {
    ok: true,
    draft: {
      settings: { baseUrl: input.endpoint.trim() },
      credentials: { token: input.token.trim() },
    },
  };
}
