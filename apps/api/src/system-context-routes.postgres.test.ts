import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createApp } from "./app.js";
import { SYSTEM_CONTEXT_ROUTES } from "./system-context-routes.js";
import { systemContextRoutes } from "./system-context-routes.test-support.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;

it.skipIf(!databaseUrl)(
  "serves only reviewed machine-to-machine routes with a system database context",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-system-context-"));
    // Every optional feature that mounts a route under a system-context path is switched on.
    const handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      scimBearerToken: "system-context-directory-token-0123456789",
      inboundEmail: { domain: "bots.rakazo.test", secret: "system-context-inbound-email-secret" },
      slackClientId: "system-context-client-id",
      slackClientSecret: "system-context-client-secret",
      slackSigningSecret: "system-context-signing-secret",
    });
    try {
      const registered = systemContextRoutes(handles.app);
      const reviewed = Object.keys(SYSTEM_CONTEXT_ROUTES).sort();
      expect(
        registered.filter((route) => !reviewed.includes(route)),
        "Routes under SYSTEM_CONTEXT_PATHS run with a system database context, which bypasses " +
          "row-level security. Mount a route that acts for a signed-in user under another path, " +
          "where it runs in that user's tenant context. For a machine-to-machine route, add it " +
          "to SYSTEM_CONTEXT_ROUTES with how it authenticates its caller.",
      ).toEqual([]);
      expect(
        reviewed.filter((route) => !registered.includes(route)),
        "SYSTEM_CONTEXT_ROUTES lists a route this app does not register. Remove the entry, or " +
          "switch on the feature that mounts it in this test.",
      ).toEqual([]);
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
