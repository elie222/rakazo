import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppHandles } from "../app.js";
import { createApp } from "../app.js";
import { loadEnv } from "../env.js";
import { anonymousRequests, rawRoutes, systemContextRoutes } from "./raw-routes.test-support.js";
import { SESSIONLESS_ROUTES } from "./sessionless-routes.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;

describe.skipIf(!databaseUrl)("raw routes", () => {
  const reviewed = Object.keys(SESSIONLESS_ROUTES);
  let dataDir: string;
  let handles: AppHandles;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "rakazo-raw-routes-"));
    vi.stubEnv("MEETING_PROVIDER", "emulator");
    vi.stubEnv("MEETING_PUBLIC_ORIGIN", "https://meetings.example.test");
    // Every optional feature that mounts a raw route is switched on.
    handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      scimBearerToken: "raw-routes-directory-token-0123456789",
      inboundEmail: { domain: "bots.rakazo.test", secret: "raw-routes-inbound-email-secret" },
      slackClientId: "raw-routes-client-id",
      slackClientSecret: "raw-routes-client-secret",
      slackSigningSecret: "raw-routes-signing-secret",
      billingEmulator: true,
      userDevicesEnabled: true,
      emailEmulator: true,
      nodeEnv: "development",
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await handles?.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("serves only reviewed machine-to-machine routes with a system database context", () => {
    expect(
      systemContextRoutes(handles.app).filter((route) => !reviewed.includes(route)),
      "Routes under SYSTEM_CONTEXT_PATHS run with a system database context, which bypasses " +
        "row-level security. Mount a route that acts for a signed-in user under another path, " +
        "where it runs in that user's tenant context. For a machine-to-machine route, add it " +
        "to SESSIONLESS_ROUTES with how it authenticates its caller.",
    ).toEqual([]);
  });

  it("refuses a request without credentials, by each method, unless reviewed as sessionless", async () => {
    const { webOrigin } = loadEnv(process.env);
    const answered: string[] = [];
    for (const route of rawRoutes(handles.app).filter((route) => !reviewed.includes(route))) {
      for (const request of anonymousRequests(route)) {
        const response = await handles.app.request(request);
        await response.body?.cancel();
        const refused =
          response.status === 401 ||
          response.status === 403 ||
          // A browser navigation goes back to the web app, where a signed-out visitor signs in.
          (response.status === 303 && response.headers.get("location") === webOrigin);
        if (!refused) answered.push(`${route}: ${request.method} answered ${response.status}`);
      }
    }
    expect(
      answered,
      "RPC procedures share one sign-in step, but a raw route checks its caller itself, and one " +
        "that forgets serves anyone. These routes did not refuse a request that carried no " +
        "credentials. Refuse it before any work with 401 or 403 (a browser navigation may " +
        "redirect to the web app instead). If the route is meant to be public, or knows its " +
        "caller by a signed link, a shared secret or a signature, add it to SESSIONLESS_ROUTES " +
        "with how. If only one branch of it answers, add that branch by its query.",
    ).toEqual([]);
  });

  it("rejects unsigned meeting events", async () => {
    const response = await handles.app.request("/api/meetings/events", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("refuses meeting media access without a grant", async () => {
    const session = await handles.app.request("/api/meetings/media/session");
    const turn = await handles.app.request("/api/meetings/media/turn", { method: "POST" });
    expect(session.status).toBe(401);
    expect(turn.status).toBe(401);
  });

  it("refuses unsigned meeting calendar events", async () => {
    const response = await handles.app.request("/api/meetings/calendar/webhook", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(400);
  });

  it("reviews only routes the app registers", () => {
    const registered = rawRoutes(handles.app);
    expect(
      // A key with a query reviews one branch of the route it names.
      reviewed.filter((route) => !registered.includes(route.replace(/\?.*$/, ""))),
      "SESSIONLESS_ROUTES lists a route this app does not register. Remove the entry, or " +
        "switch on the feature that mounts it in this test.",
    ).toEqual([]);
  });
});
