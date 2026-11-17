import type { ApplicationServices } from "@rakazo/adapters";
import { loadConfiguredApps, providerScopeKey } from "@rakazo/adapters";
import type { Auth } from "@rakazo/auth";
import type { Actor } from "@rakazo/contracts";
import type { Hono } from "hono";
import { userAppCredentialReader } from "./connected-app-credentials.js";
import type { AppEnv } from "./env.js";

/** API-only composition; authentication never becomes a worker or adapter dependency. */
export async function createConnectedApps(
  services: Pick<ApplicationServices, "prisma" | "artifacts" | "events"> & {
    env: Pick<AppEnv, "maxUploadSizeBytes" | "oidc">;
  },
  getAuth: () => Auth,
) {
  const { prisma, artifacts, events, env } = services;
  const apps = await loadConfiguredApps({
    prisma,
    artifacts,
    events,
    env: process.env,
    maxUploadSizeBytes: env.maxUploadSizeBytes,
    credentials: (userId) => userAppCredentialReader(prisma, getAuth(), env.oidc?.issuer)(userId),
    providerScopeKey,
  });
  return {
    ...apps,
    mount(app: Hono) {
      app.post("/internal/apps/:id", (c) => apps.handle(c.req.raw, c.req.param("id")));
    },
    afterRpc(actor: Actor | null, request: Request, response: Response) {
      if (
        actor &&
        response.ok &&
        request.method === "POST" &&
        new URL(request.url).pathname === "/rpc/me"
      )
        apps.initialize(actor);
    },
  };
}
