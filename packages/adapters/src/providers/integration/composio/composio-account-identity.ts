import type { AdapterContext } from "@rakazo/adapter-kit";
import { accountIdentityFromResponse } from "../../../integrations/account-identity.js";
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
        if (!profile) return undefined;
        const data: unknown = profile.data;
        const address =
          data && typeof data === "object" && "emailAddress" in data
            ? data.emailAddress
            : undefined;
        return accountIdentityFromResponse(profile.status, address);
      } catch (error) {
        context.signal.throwIfAborted();
        const status = error instanceof Error && "status" in error ? error.status : undefined;
        if (isStaleConnectedAccountError(error)) return undefined;
        if (typeof status === "number") return accountIdentityFromResponse(status);
        throw new Error(sanitizeIntegrationError(error));
      }
    };
  };
}
