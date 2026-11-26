import type { AdapterContext } from "@rakazo/adapter-kit";
import type { ComposioClient } from "./composio-connector.js";
import { isStaleConnectedAccountError, sanitizeIntegrationError } from "./composio-errors.js";

export function composioAccountIdentity(
  activeRefs: (context: AdapterContext, slug: string) => Promise<string[]>,
  tools: () => Promise<ComposioClient["tools"]>,
) {
  return async (slug: string, context: AdapterContext) => {
    if (slug.trim().toLowerCase() !== "gmail") return async () => undefined;
    const refs = await activeRefs(context, slug).catch((error: unknown) => {
      context.signal.throwIfAborted();
      throw new Error(sanitizeIntegrationError(error));
    });
    const active = new Set(refs);
    return async (ref: string) => {
      if (!active.has(ref)) return undefined;
      try {
        const profile = await (await tools())?.proxyExecute(
          {
            endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
            method: "GET",
            connectedAccountId: ref,
          },
          { signal: context.signal },
        );
        if (profile && (profile.status >= 500 || profile.status === 429))
          throw new Error(`Profile lookup returned HTTP ${profile.status}`);
        const data = profile?.data;
        if (
          profile?.status !== 200 ||
          !data ||
          typeof data !== "object" ||
          !("emailAddress" in data)
        )
          return undefined;
        const address = data.emailAddress;
        return typeof address === "string" ? address.trim().toLowerCase() || undefined : undefined;
      } catch (error) {
        context.signal.throwIfAborted();
        const status = error instanceof Error && "status" in error ? error.status : undefined;
        if (status === 401 || status === 403 || status === 404) return undefined;
        if (isStaleConnectedAccountError(error)) return undefined;
        throw new Error(sanitizeIntegrationError(error));
      }
    };
  };
}
