import type { AdapterContext } from "@rakazo/adapter-kit";
import {
  mailboxProfileIdentity,
  mailboxProfileUrl,
} from "../../../integrations/mailbox-profile.js";
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
            endpoint: mailboxProfileUrl,
            method: "GET",
            connectedAccountId: ref,
          },
          { signal: context.signal },
        );
        return profile ? mailboxProfileIdentity(profile.status, profile.data) : undefined;
      } catch (error) {
        context.signal.throwIfAborted();
        const status = error instanceof Error && "status" in error ? error.status : undefined;
        if (isStaleConnectedAccountError(error)) return undefined;
        if (typeof status === "number") return mailboxProfileIdentity(status);
        throw new Error(sanitizeIntegrationError(error));
      }
    };
  };
}
