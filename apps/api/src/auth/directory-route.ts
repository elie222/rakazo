import { AsyncLocalStorage } from "node:async_hooks";
import type { DirectoryAccountChange } from "@rakazo/auth";
import { CLIENT_IP_HEADER, createDirectory } from "@rakazo/auth";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import type { AccountStatusDeps } from "../account/account-status.js";
import { settleDirectoryChange } from "../account/account-status.js";
import type { AppEnv } from "../env.js";
import { requestClientIp, withClientIp } from "../http/client-ip.js";
import { authLibraryLogger, withAuthLibraryFailures } from "./auth-library-failures.js";

/** SCIM provisioning from the identity provider; undefined when no bearer token is configured. */
export async function scimDirectory(
  prisma: PrismaClient,
  env: Pick<AppEnv, "scimBearerToken" | "authSecret" | "authUrl">,
) {
  if (!env.scimBearerToken) return undefined;
  // A SCIM request records the accounts it turned off or on; the route settles them after commit.
  const directoryChanges = new AsyncLocalStorage<DirectoryAccountChange[]>();
  const directory = await createDirectory(prisma, {
    token: env.scimBearerToken,
    secret: env.authSecret,
    baseURL: env.authUrl,
    ipAddressHeader: CLIENT_IP_HEADER,
    logger: authLibraryLogger("directory.request.failed"),
    onAccountChange: (change) => directoryChanges.getStore()?.push(change),
  });
  return {
    mount(app: Hono, settle: AccountStatusDeps) {
      app.on(["GET", "POST", "PUT", "PATCH", "DELETE"], "/api/auth/scim/v2/*", async (c) => {
        const changes: DirectoryAccountChange[] = [];
        const response = await directoryChanges.run(changes, () =>
          withAuthLibraryFailures(() =>
            directory.handler(withClientIp(c.req.raw, requestClientIp(c))),
          ),
        );
        // A retried write reports an account again; the last report per account stands.
        const latest = new Map(changes.map((change) => [change.userId, change]));
        let unfinished = false;
        for (const change of latest.values())
          await settleDirectoryChange(settle, change).catch((error) => {
            unfinished = true;
            // Sign-in and runs are already refused. A retried update finishes the rest; after a
            // delete, the operator's `account-status.js deactivate` does.
            getLogger().error("directory.account_change.unfinished", error, {
              "user.id": change.userId,
            });
          });
        if (unfinished) {
          // The directory change committed. Failing the request makes the provider retry it.
          return c.json(
            {
              schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
              status: "500",
              detail: "Could not finish the change; retry it",
            },
            500,
            { "content-type": "application/scim+json" },
          );
        }
        return response;
      });
    },
  };
}
