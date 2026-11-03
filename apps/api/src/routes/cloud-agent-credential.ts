import { ORPCError } from "@orpc/server";
import type { CloudAgentCredentialDeps } from "@rakazo/adapters";
import {
  CloudAgentCredentialBusy,
  CloudAgentCredentialRejected,
  cloudAgentCredentialStatus,
  connectCloudAgentCredential,
  disconnectCloudAgentCredential,
} from "@rakazo/adapters";
import type { RouterContext } from "./context.js";

export function cloudAgentCredentialRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const credentials: CloudAgentCredentialDeps = {
    prisma: deps.prisma,
    secretStore: deps.secrets,
    cloudAgent: deps.cloudAgent,
  };
  return {
    cloudAgentCredential: {
      status: authed.cloudAgentCredential.status.handler(({ context }) =>
        cloudAgentCredentialStatus(credentials, context.actor),
      ),
      connect: authed.cloudAgentCredential.connect.handler(async ({ context, input }) => {
        if (!deps.cloudAgent?.userCredentialProviderId) throw new ORPCError("NOT_FOUND");
        try {
          return await connectCloudAgentCredential(credentials, context.actor, input.apiKey);
        } catch (error) {
          if (
            error instanceof CloudAgentCredentialRejected ||
            error instanceof CloudAgentCredentialBusy
          ) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
      }),
      disconnect: authed.cloudAgentCredential.disconnect.handler(async ({ context }) => {
        if (!deps.cloudAgent?.userCredentialProviderId) throw new ORPCError("NOT_FOUND");
        try {
          return await disconnectCloudAgentCredential(credentials, context.actor);
        } catch (error) {
          if (error instanceof CloudAgentCredentialBusy) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
      }),
    },
  };
}
