import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import {
  MEMORY_REVISION_CONFLICT_ERROR,
  MemoryRevisionConflictError,
  MessagingInstallRefusedError,
  routineWakeupJob,
  SecretStoreUnavailableError,
} from "@rakazo/adapter-kit";
import * as adapters from "@rakazo/adapters";
import { LocalAgentHomeStore, serializeModelSecret } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter as createRouterWith } from "./router.js";
import { appHandler, createRouter, handle } from "./router-test-support.js";

describe("account preferences", () => {
  function preferencesDeps(avatarStyle: string, timezone: string | null = null) {
    const update = vi.fn().mockResolvedValue({});
    const user = {
      email: "user@rakazo.test",
      name: "Test User",
      avatarStyle,
      timezone,
      secrets: [],
    };
    const updateMany = vi.fn(
      async ({ where, data }: { where: { timezone: null }; data: { timezone: string } }) => {
        if (user.timezone !== where.timezone) return { count: 0 };
        Object.assign(user, data);
        return { count: 1 };
      },
    );
    const botFindMany = vi.fn().mockResolvedValue([]);
    const routines: Record<string, unknown>[] = [];
    const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
      Object.entries(where).every(([key, value]) =>
        value && typeof value === "object" && "in" in value
          ? (value.in as unknown[]).includes(row[key])
          : row[key] === value,
      );
    const prisma = {
      user: {
        update,
        updateMany,
        findUnique: vi.fn(async () => ({ timezone: user.timezone })),
        findUniqueOrThrow: vi.fn().mockResolvedValue(user),
      },
      bot: { findMany: botFindMany },
      routine: {
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
          routines.filter((row) => matches(row, where)),
        ),
        updateMany: vi.fn(
          async ({
            where,
            data,
          }: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
          }) => {
            let count = 0;
            for (const [index, row] of routines.entries()) {
              if (!matches(row, where)) continue;
              routines[index] = { ...row, ...data };
              count += 1;
            }
            return { count };
          },
        ),
      },
      $transaction: vi.fn(async (run: (client: unknown) => Promise<unknown>) => run(prisma)),
      $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        if (sql.includes("FOR SHARE")) return [{ timezone: user.timezone }];
        if (sql.includes('"routines"')) {
          return routines
            .filter((row) => matches(row, { userId: values[0], timezone: values[1] }))
            .map((row) => ({ id: row.id }));
        }
        return [];
      }),
      userModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    return {
      update,
      updateMany,
      botFindMany,
      routines,
      deps,
      actor,
      handler: new RPCHandler(createRouter(deps)),
    };
  }

  it("records only validated screens under the authenticated actor", async () => {
    const { deps, actor } = preferencesDeps("robot");
    const capture = vi.fn();
    deps.analytics = { capture, flush: async () => undefined };
    const client = createRouterClient(createRouter(deps), { context: { actor } as never });
    await expect(client.analytics.screen({ screen: "chat", surface: "desktop" })).resolves.toEqual({
      ok: true,
    });
    expect(capture).toHaveBeenCalledWith(
      actor.userId,
      { name: "screen_viewed", screen: "chat", surface: "desktop" },
      undefined,
      undefined,
    );
    await client.analytics.screen({ screen: "plans", surface: "web", planLayout: "tiers" });
    expect(capture).toHaveBeenLastCalledWith(
      actor.userId,
      { name: "screen_viewed", screen: "plans", surface: "web", planLayout: "tiers" },
      undefined,
      { "plan-layout": "tiers" },
    );
    await expect(
      client.analytics.screen({
        screen: "chat",
        surface: "web",
        email: "private@example.test",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const anonymous = createRouterClient(createRouter(deps), { context: {} as never });
    await expect(
      anonymous.analytics.screen({ screen: "chat", surface: "web" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("reports model credential store outages as service unavailable", async () => {
    const { deps, actor } = preferencesDeps("robot");
    Object.assign(deps.prisma, {
      userModelCredential: {
        findMany: vi.fn(async () => [{ secretId: "secret", userPreferences: [] }]),
      },
      secret: { findMany: vi.fn(async () => [{ id: "secret", ciphertext: "ref" }]) },
    });
    deps.secrets = {
      load: vi.fn(async () => {
        throw new SecretStoreUnavailableError();
      }),
    } as never;
    const response = await handle(
      appHandler(deps),
      new Request("http://127.0.0.1/rpc/models/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      { prefix: "/rpc", context: { actor } as never },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      json: { code: "SERVICE_UNAVAILABLE", status: 503, message: "Service Unavailable" },
    });
  });

  it("marks the connection running the main role as the default", async () => {
    const { deps, actor } = preferencesDeps("robot");
    const connection = (id: string, modelId: string) => ({
      id,
      userId: actor.userId,
      provider: "openrouter",
      label: id,
      secretId: `secret-${id}`,
      supportsImages: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      userPreferences: [{ credentialId: id, modelId, thinkingLevel: null, updatedAt: new Date(0) }],
    });
    const rows = [connection("first", "own-first"), connection("second", "own-second")];
    Object.assign(deps.prisma, {
      userModelCredential: {
        findMany: vi.fn(async () => rows),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          rows.find((row) => row.id === where.id),
        ),
      },
      secret: { findMany: vi.fn(async () => []) },
    });
    // preferencesDeps already gave these deps their role table.
    const client = createRouterClient(createRouterWith(deps), { context: { actor } as never });
    await (
      deps.prisma.userModelRoleChoice as unknown as {
        createMany: (args: { data: unknown[] }) => Promise<unknown>;
      }
    ).createMany({
      data: [
        {
          userId: actor.userId,
          spaceId: actor.spaceId,
          role: "main",
          position: 0,
          provider: "openrouter",
          modelId: "main-model",
          thinkingLevel: "high",
          credentialId: "second",
        },
      ],
    });

    const credentials = await client.models.credentials();

    expect(credentials.map(({ id, isDefault, modelId }) => ({ id, isDefault, modelId }))).toEqual([
      { id: "first", isDefault: false, modelId: "own-first" },
      { id: "second", isDefault: true, modelId: "main-model" },
    ]);
  });

  it("keeps a compatible connection's own model enabled while it shows the main model", async () => {
    const { deps, actor } = preferencesDeps("robot");
    const row = {
      id: "compatible",
      userId: actor.userId,
      provider: "openai-compatible",
      label: "Local",
      secretId: "secret-compatible",
      supportsImages: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      // Its own model is outside the stored list, which enables only the main model.
      userPreferences: [
        {
          credentialId: "compatible",
          modelId: "own-a",
          thinkingLevel: null,
          updatedAt: new Date(0),
        },
      ],
    };
    Object.assign(deps.prisma, {
      userModelCredential: {
        findMany: vi.fn(async () => [row]),
        findFirst: vi.fn(async () => row),
      },
      secret: {
        findMany: vi.fn(async () => [{ id: row.secretId, ciphertext: "fake-ciphertext" }]),
      },
    });
    deps.secrets = {
      load: vi.fn(async () =>
        serializeModelSecret({
          kind: "openai_compatible",
          baseUrl: "http://127.0.0.1:11434/v1",
          enabledModelIds: ["main-b"],
        }),
      ),
    } as never;
    // preferencesDeps already gave these deps their role table.
    const client = createRouterClient(createRouterWith(deps), { context: { actor } as never });
    await (
      deps.prisma.userModelRoleChoice as unknown as {
        createMany: (args: { data: unknown[] }) => Promise<unknown>;
      }
    ).createMany({
      data: [
        {
          userId: actor.userId,
          spaceId: actor.spaceId,
          role: "main",
          position: 0,
          provider: "openai-compatible",
          modelId: "main-b",
          thinkingLevel: null,
          credentialId: row.id,
        },
      ],
    });

    const [credential] = await client.models.credentials();

    expect(credential).toMatchObject({ isDefault: true, modelId: "main-b" });
    expect(credential?.enabledModelIds).toEqual(["main-b", "own-a"]);
  });

  it("keeps an unconfigured catalog offline unless explicitly requested", async () => {
    const { actor, deps } = preferencesDeps("robot");
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    deps.remoteConnectors = { fetch } as RouterDeps["remoteConnectors"];
    const handler = new RPCHandler(createRouter(deps));
    const request = async (usePublicCatalog?: boolean) =>
      handle(
        handler,
        new Request("http://127.0.0.1/rpc/capabilities/catalogSearch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { query: "notion", usePublicCatalog } }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
    const response = await request();
    await expect(response.json()).resolves.toEqual({ json: { enabled: false, results: [] } });
    expect(fetch).not.toHaveBeenCalled();
    await request(true);
    expect(fetch).toHaveBeenCalled();
  });

  it("accepts an avatar style from an older app without storing it", async () => {
    const { update, actor, handler } = preferencesDeps("organic");

    const response = await handle(
      handler,
      new Request("http://127.0.0.1/rpc/preferences/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { avatarStyle: "robot" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ where: { id: "user-1" }, data: {} });
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ avatarStyle: "organic" }),
    });
  });

  it("saves the bot style and restyles only bots not pinned to another set", async () => {
    const { update, botFindMany, actor, handler } = preferencesDeps("organic");

    const response = await handle(
      handler,
      new Request("http://127.0.0.1/rpc/preferences/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botAvatarSet: "rakazo" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { botAvatarSet: "rakazo" },
    });
    expect(botFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", avatarSetPinned: false, avatarSet: { not: "rakazo" } },
      }),
    );
  });

  it("rejects avatar styles outside robot|organic", async () => {
    const { update, actor, handler } = preferencesDeps("robot");

    const response = await handle(
      handler,
      new Request("http://127.0.0.1/rpc/preferences/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { avatarStyle: "dicebear" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(update).not.toHaveBeenCalled();
  });

  async function updatePreferences(
    { handler, actor }: ReturnType<typeof preferencesDeps>,
    json: unknown,
  ) {
    const response = await handle(
      handler,
      new Request("http://127.0.0.1/rpc/preferences/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

  it("persists an IANA timezone without touching the avatar style", async () => {
    const setup = preferencesDeps("organic");

    const response = await updatePreferences(setup, { timezone: "Pacific/Auckland" });

    expect(response.status).toBe(200);
    expect(setup.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { timezone: "Pacific/Auckland" },
    });
  });

  it("saves the timezone and the language preference in one write", async () => {
    const setup = preferencesDeps("organic", "Africa/Cairo");

    const response = await updatePreferences(setup, {
      timezone: "Europe/London",
      locale: "pt-BR",
    });

    expect(response.status).toBe(200);
    expect(setup.update).toHaveBeenCalledTimes(1);
    expect(setup.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { timezone: "Europe/London", locale: "pt-BR" },
    });
  });

  it("moves routines that took the account zone to the new one", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-04T12:00:00.000Z") });
    try {
      const setup = preferencesDeps("organic", "Africa/Cairo");
      setup.routines.push(
        {
          id: "routine-1",
          userId: "user-1",
          crons: ["0 9 * * 1"],
          timezone: "Africa/Cairo",
          active: true,
          watch: null,
          nextRunAt: new Date("2026-11-09T07:00:00.000Z"),
        },
        {
          id: "routine-2",
          userId: "user-1",
          crons: ["0 9 * * 1"],
          timezone: "Asia/Tokyo",
          active: true,
          watch: null,
          nextRunAt: new Date("2026-11-09T00:00:00.000Z"),
        },
      );

      const response = await updatePreferences(setup, { timezone: "Europe/London" });

      expect(response.status).toBe(200);
      // The routine that took the account zone keeps Monday 09:00 in London; the pinned one stays.
      expect(setup.routines[0]).toMatchObject({
        timezone: "Europe/London",
        nextRunAt: new Date("2026-11-09T09:00:00.000Z"),
      });
      expect(setup.routines[1]).toMatchObject({ timezone: "Asia/Tokyo" });
      expect(setup.deps.jobs.enqueue).toHaveBeenCalledWith(
        routineWakeupJob("routine-1", new Date("2026-11-09T09:00:00.000Z")),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves the app language emails are written in", async () => {
    const setup = preferencesDeps("organic");

    const response = await updatePreferences(setup, { locale: "pt-BR" });

    expect(response.status).toBe(200);
    expect(setup.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { locale: "pt-BR" },
    });
  });

  it.each([null, "Europe/London"])(
    "adopts the browser timezone only while the saved value is null (%s)",
    async (timezone) => {
      const setup = preferencesDeps("organic", timezone);
      const client = createRouterClient(createRouter(setup.deps), {
        context: { actor: setup.actor } as never,
      });
      const me = await client.preferences.adoptTimezone({ timezone: "Pacific/Auckland" });
      expect(setup.updateMany).toHaveBeenCalledWith({
        where: { id: "user-1", timezone: null },
        data: { timezone: "Pacific/Auckland" },
      });
      expect(me.timezone).toBe(timezone ?? "Pacific/Auckland");
      expect(setup.update).not.toHaveBeenCalled();
    },
  );

  it.each([{ timezone: "Mars/Olympus_Mons" }, { timezone: "" }, {}])(
    "rejects an unknown timezone or an empty update: %j",
    async (json) => {
      const setup = preferencesDeps("robot");

      const response = await updatePreferences(setup, json);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(setup.update).not.toHaveBeenCalled();
    },
  );

  it("rejects adopting an unknown timezone", async () => {
    const setup = preferencesDeps("robot");
    const response = await handle(
      setup.handler,
      new Request("http://127.0.0.1/rpc/preferences/adoptTimezone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { timezone: "Mars/Olympus_Mons" } }),
      }),
      { prefix: "/rpc", context: { actor: setup.actor } },
    );

    expect(response?.status).toBeGreaterThanOrEqual(400);
    expect(setup.updateMany).not.toHaveBeenCalled();
  });

  it.each(["robot", "organic", "custom-cdn"])(
    "always reports the organic style, whatever is stored (%s)",
    async (style) => {
      const { actor, handler } = preferencesDeps(style);

      const response = await handle(
        handler,
        new Request("http://127.0.0.1/rpc/me", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: null }),
        }),
        { prefix: "/rpc", context: { actor } },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        json: expect.objectContaining({ avatarStyle: "organic" }),
      });
    },
  );

  it.each([false, true])("checks work-card support before a token exists (%s)", async (enabled) => {
    const { deps, actor } = preferencesDeps("robot");
    const register = vi.fn().mockResolvedValue(false);
    deps.workActivities = enabled ? { register, registerStarts: vi.fn() } : undefined;
    const phone = createRouterClient(createRouter(deps), {
      context: { actor, sessionId: "session-phone" } as never,
    });

    await expect(phone.notifications.followWorkActivity({})).resolves.toEqual({
      following: enabled,
    });
    expect(register).not.toHaveBeenCalled();

    // Token registration still reports whether there is work to follow.
    const token = "ab".repeat(32);
    await expect(phone.notifications.followWorkActivity({ token })).resolves.toEqual({
      following: false,
    });
    if (enabled) expect(register).toHaveBeenCalledWith(actor.userId, "session-phone", token);
    else expect(register).not.toHaveBeenCalled();
  });

  describe("registering a device from a session that was signed out meanwhile", () => {
    const registrations = [
      ["notifications/registerPush", { token: "ExponentPushToken[fake-token]" }],
      [
        "notifications/registerCallPush",
        {
          deviceId: "11111111-1111-4111-8111-111111111111",
          platform: "android",
          expoToken: "ExponentPushToken[fake-token]",
        },
      ],
    ] as const;
    const register = (deps: RouterDeps, actor: Actor, path: string, body: unknown) =>
      handle(
        appHandler(deps),
        new Request(`http://127.0.0.1/rpc/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: body }),
        }),
        { prefix: "/rpc", context: { actor, sessionId: "session-phone" } as never },
      );
    const failingStore = (error: Error) => ({
      list: vi.fn(async () => []),
      save: vi.fn().mockRejectedValue(error),
      saveDevice: vi.fn().mockRejectedValue(error),
      importLegacy: vi.fn(async () => false),
      endSession: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    });

    it.each(registrations)("answers %s as unauthorized", async (path, body) => {
      const { deps, actor } = preferencesDeps("robot");
      deps.pushTokens = failingStore(new adapters.PushSessionEndedError());

      const response = await register(deps, actor, path, body);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        json: { defined: false, code: "UNAUTHORIZED", status: 401, message: "Unauthorized" },
      });
    });

    it.each(registrations)("reports any other %s failure as a server fault", async (path, body) => {
      const { deps, actor } = preferencesDeps("robot");
      deps.pushTokens = failingStore(new Error("token table is locked"));

      const response = await register(deps, actor, path, body);

      expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).not.toContain("token table");
    });
  });

  it("ends only the calling session's push registration, keeping another session's", async () => {
    const { deps, actor } = preferencesDeps("robot");
    const calls: string[] = [];
    deps.pushTokens = {
      list: vi.fn(async () => []),
      save: vi.fn(async () => undefined),
      importLegacy: vi.fn(async () => false),
      endSession: vi.fn(async (userId: string, sessionId: string) => {
        calls.push(`endSession ${userId} ${sessionId}`);
      }),
      remove: vi.fn(async (userId: string) => {
        calls.push(`remove ${userId}`);
      }),
    };
    // A tablet of the same account holds the registration; the phone's session signs out.
    const phone = createRouterClient(createRouter(deps), {
      context: { actor, sessionId: "session-phone" } as never,
    });
    await expect(phone.notifications.unregisterPush()).resolves.toEqual({ ok: true });
    expect(calls).toEqual([`endSession ${actor.userId} session-phone`]);

    // Without a session to end, the account-wide registration is still removed.
    const sessionless = createRouterClient(createRouter(deps), { context: { actor } as never });
    await expect(sessionless.notifications.unregisterPush()).resolves.toEqual({ ok: true });
    expect(calls).toEqual([`endSession ${actor.userId} session-phone`, `remove ${actor.userId}`]);
  });
});

describe("billing", () => {
  const surveyCreatedAt = new Date("2026-10-23T12:00:00Z");
  const upsertSignupSurvey = vi.fn().mockResolvedValue({ createdAt: surveyCreatedAt });

  function billingDeps(
    isDeploymentOwner: boolean,
    billing?: RouterDeps["billing"],
    signupSurvey: { userId: string } | null = null,
    analytics?: RouterDeps["analytics"],
  ) {
    const prisma = {
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "user@rakazo.test",
          name: "Test User",
          avatarStyle: "robot",
          signupSurvey,
          secrets: [],
        }),
      },
      signupSurvey: { upsert: upsertSignupSurvey },
      userModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      billing,
      analytics,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner,
    } satisfies Actor;
    return createRouterClient(createRouter(deps), { context: { actor } });
  }

  it("is not found when the deployment does not bill", async () => {
    const client = billingDeps(false);
    await expect(client.billing.status()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.billing.checkout()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.billing.selectFunding({ funding: "credits" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      client.billing.purchaseCredits({ amountCents: 2000, monthly: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.billing.setMonthlyCredits({ amountCents: 2000 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(client.me()).resolves.toMatchObject({ billingEnabled: false });
  });

  it("enables billing on me for admins too", async () => {
    const billing = { status: vi.fn() } as unknown as RouterDeps["billing"];
    await expect(billingDeps(false, billing).me()).resolves.toMatchObject({
      billingEnabled: true,
    });
    await expect(billingDeps(true, billing).me()).resolves.toMatchObject({
      billingEnabled: true,
    });
  });

  it("asks hosted users the signup survey until they answer or skip it", async () => {
    const billing = { status: vi.fn() } as unknown as RouterDeps["billing"];
    await expect(billingDeps(false).me()).resolves.toMatchObject({ needsSignupSurvey: false });
    await expect(billingDeps(false, billing).me()).resolves.toMatchObject({
      needsSignupSurvey: true,
    });
    await expect(billingDeps(false, billing, { userId: "user-1" }).me()).resolves.toMatchObject({
      needsSignupSurvey: false,
    });
  });

  it("sends only the fixed survey choices to analytics", async () => {
    const capture = vi.fn();
    const client = billingDeps(false, undefined, null, { capture, flush: async () => undefined });
    await client.onboarding.signupSurvey({
      use: "work",
      teamSize: "2-10",
      reason: "Private plans",
      source: "A friend",
    });
    await client.onboarding.signupSurvey({});
    expect(capture.mock.calls.map(([userId, event]) => [userId, event])).toEqual([
      ["user-1", { name: "signup_survey_answered", skipped: false, use: "work", teamSize: "2-10" }],
      ["user-1", { name: "signup_survey_answered", skipped: true }],
    ]);
    expect(capture.mock.calls.map(([, , identity]) => identity)).toEqual([
      { id: "user-1", at: surveyCreatedAt },
      { id: "user-1", at: surveyCreatedAt },
    ]);
  });

  it("records a blank survey as skipped", async () => {
    await billingDeps(false).onboarding.signupSurvey({});
    expect(upsertSignupSurvey).toHaveBeenLastCalledWith({
      where: { userId: "user-1" },
      create: { userId: "user-1", reason: null, use: null, teamSize: null, source: null },
      update: { reason: null, use: null, teamSize: null, source: null },
    });
  });

  it("keeps team size only for work or both", async () => {
    const client = billingDeps(false);
    await client.onboarding.signupSurvey({
      reason: "  Run my inbox  ",
      use: "personal",
      teamSize: "11-50",
      source: "",
    });
    expect(upsertSignupSurvey).toHaveBeenLastCalledWith({
      where: { userId: "user-1" },
      create: {
        userId: "user-1",
        reason: "Run my inbox",
        use: "personal",
        teamSize: null,
        source: null,
      },
      update: { reason: "Run my inbox", use: "personal", teamSize: null, source: null },
    });

    await client.onboarding.signupSurvey({ use: "work", teamSize: "11-50" });
    expect(upsertSignupSurvey).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: { reason: null, use: "work", teamSize: "11-50", source: null },
      }),
    );

    await client.onboarding.signupSurvey({ use: "both", teamSize: "2-10" });
    expect(upsertSignupSurvey).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: { reason: null, use: "both", teamSize: "2-10", source: null },
      }),
    );
  });
});

describe("updater owner gate", () => {
  function updaterDeps() {
    const prisma = {
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "user@rakazo.test",
          name: "Test User",
          avatarStyle: "robot",
          secrets: [],
        }),
      },
      userModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
        gitSha: "deadbeef",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    return { deps, handler: new RPCHandler(createRouter(deps)) };
  }

  it("forbids non-owners from updater status", async () => {
    const { handler } = updaterDeps();
    const actor = {
      spaceId: "workspace-1",
      userId: "user-2",
      email: "member@rakazo.test",
      isDeploymentOwner: false,
    } satisfies Actor;

    const response = await handle(
      handler,
      new Request("http://127.0.0.1/rpc/updater/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: null }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(403);
  });

  it("denies a legacy owner server update status", async () => {
    const { handler } = updaterDeps();
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "owner@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;

    const response = await handle(
      handler,
      new Request("http://127.0.0.1/rpc/updater/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: null }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(403);
  });

  it("refuses apply when the sidecar is not configured", async () => {
    const { handler } = updaterDeps();
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "owner@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;

    const response = await handle(
      handler,
      new Request("http://127.0.0.1/rpc/updater/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(403);
  });
});

describe("server operation authorization", () => {
  it.each([false, true])(
    "rejects server administration even with legacy owner flag %s",
    async (isDeploymentOwner) => {
      const prisma = { deploymentSettings: { update: vi.fn() }, $transaction: vi.fn() };
      const client = createRouterClient(
        createRouter({
          prisma,
          env: { webOrigin: "https://example.test" },
        } as unknown as RouterDeps),
        {
          context: {
            actor: {
              userId: "user",
              spaceId: "space",
              email: "user@example.test",
              isDeploymentOwner,
            },
          } as never,
        },
      );
      for (const call of [
        () => client.deployment.get(),
        () => client.deployment.update({ signupsEnabled: true }),
        () => client.security.events({}),
        () => client.updater.status(),
        () => client.updater.check({}),
        () => client.updater.apply({}),
        () => client.computer.releaseInterrupted({ id: "update-1", workersStopped: true }),
        () => client.integrationSetup.save({ provider: "composio", apiKey: "fake-key" }),
      ])
        await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(prisma.deploymentSettings.update).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
});

describe("link favicons", () => {
  function faviconClient(actor: Actor | null) {
    const favicon = vi.fn().mockResolvedValue({ icon: "data:image/png;base64,AAAA" });
    const deps = {
      prisma: {} as PrismaClient,
      favicons: { favicon },
      env: { webOrigin: "http://127.0.0.1:5173", screenProxySecret: "fake-test-secret" },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const client = createRouterClient(createRouter(deps), { context: { actor } });
    return { client, favicon };
  }

  const reader = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: false,
  } satisfies Actor;

  it("answers a signed-in reader with the resolved icon for an origin", async () => {
    const { client, favicon } = faviconClient(reader);
    await expect(client.links.favicon({ origin: "https://x.com" })).resolves.toEqual({
      icon: "data:image/png;base64,AAAA",
    });
    expect(favicon).toHaveBeenCalledWith("https://x.com");
  });

  it("passes a busy answer through so the client can ask again", async () => {
    const { client, favicon } = faviconClient(reader);
    favicon.mockResolvedValue({ icon: null, retry: true });
    await expect(client.links.favicon({ origin: "https://x.com" })).resolves.toEqual({
      icon: null,
      retry: true,
    });
  });

  it("accepts the longest origin a host name allows and nothing longer", async () => {
    const { client, favicon } = faviconClient(reader);
    // 253 characters: three 63-character labels and one 61-character label.
    const host = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
    expect(host).toHaveLength(253);
    const longest = `https://${host}:65535`;
    await expect(client.links.favicon({ origin: longest })).resolves.toBeDefined();
    expect(favicon).toHaveBeenCalledWith(longest);
    await expect(client.links.favicon({ origin: `${longest}0` })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("refuses a request without a session before resolving anything", async () => {
    const { client, favicon } = faviconClient(null);
    await expect(client.links.favicon({ origin: "https://x.com" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(favicon).not.toHaveBeenCalled();
  });
});

describe("adapter refusals answered by type", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const call = (deps: RouterDeps, path: string, body: unknown) =>
    handle(
      appHandler(deps),
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } as never },
    );

  describe("saving a memory document", () => {
    const save = (failure: Error) =>
      call(
        {
          prisma: {
            memoryDocument: {
              findFirst: vi.fn().mockResolvedValue({ id: "doc-1", scope: "user", path: "a.md" }),
            },
          },
          memory: { commit: vi.fn().mockRejectedValue(failure) },
        } as unknown as RouterDeps,
        "memory/update",
        { documentId: "doc-1", content: "new", expectedRevision: 1 },
      );

    it("answers a lost revision race as a conflict", async () => {
      const response = await save(new MemoryRevisionConflictError());
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        json: { code: "CONFLICT", message: MEMORY_REVISION_CONFLICT_ERROR },
      });
    });

    it("reports another failure as a fault, even one quoting the conflict", async () => {
      const response = await save(new Error(MEMORY_REVISION_CONFLICT_ERROR));
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(MEMORY_REVISION_CONFLICT_ERROR);
    });
  });

  describe("finishing a chat workspace install", () => {
    const complete = (failure: Error) =>
      call(
        {
          prisma: {},
          messagingInstallations: { complete: vi.fn().mockRejectedValue(failure) },
        } as unknown as RouterDeps,
        "messaging/installations/complete",
        { state: "s".repeat(43), code: "code" },
      );

    it("answers a refused install as a bad request", async () => {
      const response = await complete(new MessagingInstallRefusedError("Authorization expired"));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        json: { code: "BAD_REQUEST", message: "Bad Request" },
      });
    });

    it("reports another failure as a fault", async () => {
      const response = await complete(new Error("Authorization expired: database unreachable"));
      expect(response.status).toBe(500);
    });
  });

  describe("linking a chat identity to a bot", () => {
    const link = (failure: Error) =>
      call(
        {
          prisma: {
            messagingIdentity: {
              findFirst: vi.fn().mockResolvedValue({ id: "identity-1", userId: "user-1" }),
              update: vi.fn().mockRejectedValue(failure),
            },
            bot: { findFirst: vi.fn().mockResolvedValue({ id: "bot-1" }) },
          },
        } as unknown as RouterDeps,
        "messaging/identities/setBot",
        { identityId: "identity-1", botId: "bot-1" },
      );

    it("answers a bot already linked elsewhere as a bad request", async () => {
      const response = await link(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        json: { code: "BAD_REQUEST", message: "That bot is already linked to a chat app." },
      });
    });

    it("reports another failure as a fault", async () => {
      const response = await link(new Error("connection reset"));
      expect(response.status).toBe(500);
    });
  });
});

describe("export.bot", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function homeWith(files: Record<string, string | Uint8Array>) {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-export-"));
    roots.push(root);
    const home = new LocalAgentHomeStore(root);
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(home.pathFor("home-1"), file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    return home;
  }

  async function exportManifest(
    scope: "team" | "dedicated",
    home: LocalAgentHomeStore,
    appearance?: { color: string; avatarSet?: "organic" | "rakazo" },
  ) {
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          name: "Writer",
          title: "",
          description: "",
          instructions: "",
          ...appearance,
          thread: { id: "thread-1" },
          computer: { id: "computer-1", scope, homeKey: "home-1" },
        }),
      },
      memoryDocument: { findMany: vi.fn().mockResolvedValue([]) },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      message: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      home,
      env: {
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "docker",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const client = createRouterClient(createRouter(deps), { context: { actor } as never });
    const manifest = await client.export.bot({ botId: "bot-1" });
    return manifest;
  }

  async function exportFiles(scope: "team" | "dedicated", home: LocalAgentHomeStore) {
    return (await exportManifest(scope, home)).files.sort((a, b) => a.path.localeCompare(b.path));
  }

  it.each(["#8B5CF6::shape_3", "data:image/png;base64,aGVsbG8="])(
    "exports the selected set and untouched avatar value (%s)",
    async (color) => {
      const manifest = await exportManifest("team", await homeWith({}), {
        color,
        avatarSet: "rakazo",
      });
      expect(manifest.bot).toMatchObject({ color, avatarSet: "rakazo" });
    },
  );

  it("exports only the bot's own folder from a Team Computer", async () => {
    const home = await homeWith({
      "bots/bot-1/notes/result.txt": "mine",
      "bots/bot-1/project/.gitignore": "dist",
      "bots/bot-1/.cache/pip/wheel": "cache",
      "bots/bot-10/notes.txt": "prefix-sharing bot",
      "bots/bot-2/private.txt": "other bot",
      "shared/handoff.txt": "shared",
      ".cache/fontconfig/cache-1": Uint8Array.from([0, 159, 146, 150]),
      ".browser-profiles/chromium-bot-1/Cookies": "session",
    });
    const own = path.join(home.pathFor("home-1"), "bots/bot-1");
    await symlink("../bot-2", path.join(own, "peer-dir"));
    await symlink("../bot-2/private.txt", path.join(own, "peer-file"));
    await symlink("../../shared", path.join(own, "shared-link"));
    await symlink(".cache/pip/wheel", path.join(own, "wheel.txt"));

    expect(await exportFiles("team", home)).toEqual([
      { path: "notes/result.txt", content: "mine" },
      { path: "project/.gitignore", content: "dist" },
    ]);
  });

  it("keeps the bot's files that another bot links to", async () => {
    const home = await homeWith({
      "bots/bot-1/attachments/photo.bin": Uint8Array.from([0, 255]),
      "bots/bot-00/notes.txt": "other bot",
    });
    await symlink("../bot-1/attachments", path.join(home.pathFor("home-1"), "bots/bot-00/grab"));

    expect((await exportFiles("team", home)).map((file) => file.path)).toEqual([
      "attachments/photo.bin",
    ]);
  });

  it("exports nothing when the bot's Team Computer folder is a link", async () => {
    const home = await homeWith({ "bots/bot-2/private.txt": "other bot" });
    await symlink("bot-2", path.join(home.pathFor("home-1"), "bots/bot-1"));

    expect(await exportFiles("team", home)).toEqual([]);
  });

  it("skips machine state at the root of a Private Computer home", async () => {
    const home = await homeWith({
      "notes/result.txt": "mine",
      "project/.gitignore": "dist",
      ".cache/fontconfig/cache-1": Uint8Array.from([0, 159, 146, 150]),
      ".config/mimeapps.list": "[Default Applications]",
      ".browser-profiles/chromium/Cookies": "session",
      ".bash_history": "history",
    });
    const root = home.pathFor("home-1");
    await symlink(".bash_history", path.join(root, "history.txt"));
    await symlink(".config/mimeapps.list", path.join(root, "notes/mimeapps.list"));
    await symlink(".gitignore", path.join(root, "project/ignore.txt"));

    expect((await exportFiles("dedicated", home)).map((file) => file.path)).toEqual([
      "notes/result.txt",
      "project/.gitignore",
      "project/ignore.txt",
    ]);
  });

  it("keeps binary and byte-order-marked files byte-exact", async () => {
    const binary = Uint8Array.from([0, 255, 137, 80, 78, 71, 13, 10, 26, 10, 192, 128]);
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("hello")]);
    const home = await homeWith({ "image.png": binary, "bom.txt": bom, "plain.txt": "שלום ✎" });

    const files = await exportFiles("dedicated", home);
    expect(files).toEqual([
      { path: "bom.txt", content: "\uFEFFhello" },
      { path: "image.png", content: Buffer.from(binary).toString("base64"), encoding: "base64" },
      { path: "plain.txt", content: "שלום ✎" },
    ]);
    expect(new TextEncoder().encode(files[0]!.content)).toEqual(bom);
  });
});

describe("memory documents", () => {
  const actor = { userId: "user-1", spaceId: "space-1", email: "user@rakazo.test" };

  function memoryClient(
    doc: { id: string; path: string; scope: string; botId: string | null } | null,
    session: typeof actor | null = actor,
  ) {
    const memoryDocument = { findFirst: vi.fn(async () => doc) };
    const memory = { remove: vi.fn(async () => ({ removed: true })) };
    const deps = {
      prisma: { memoryDocument },
      memory,
      env: { webOrigin: "https://example.test" },
    } as unknown as RouterDeps;
    const client = createRouterClient(createRouter(deps), { context: { actor: session } as never });
    return { client, memoryDocument, memory };
  }

  it("deletes a memory document owned by the caller through the memory store", async () => {
    const { client, memoryDocument, memory } = memoryClient({
      id: "doc-1",
      path: "projects/retired.md",
      scope: "bot",
      botId: "bot-1",
    });
    await expect(client.memory.remove({ documentId: "doc-1" })).resolves.toEqual({ ok: true });
    expect(memoryDocument.findFirst).toHaveBeenCalledWith({
      where: { id: "doc-1", spaceId: "space-1" },
    });
    expect(memory.remove).toHaveBeenCalledWith(
      { id: "doc-1", scope: "bot", botId: "bot-1", path: "projects/retired.md" },
      expect.objectContaining({ spaceId: "space-1", userId: "user-1" }),
    );
  });

  it("requires a session before looking up or deleting a document", async () => {
    const { client, memoryDocument, memory } = memoryClient(null, null);
    await expect(client.memory.remove({ documentId: "doc-1" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(memoryDocument.findFirst).not.toHaveBeenCalled();
    expect(memory.remove).not.toHaveBeenCalled();
  });

  it("does not report success when the memory adapter fails", async () => {
    const { client, memory } = memoryClient({
      id: "doc-1",
      path: "projects/retired.md",
      scope: "user",
      botId: null,
    });
    memory.remove.mockRejectedValueOnce(new Error("Memory unavailable"));
    await expect(client.memory.remove({ documentId: "doc-1" })).rejects.toThrow(
      "Memory unavailable",
    );
  });

  it("keeps MEMORY.md and does not reach another user's document", async () => {
    const index = memoryClient({ id: "doc-1", path: "MEMORY.md", scope: "user", botId: null });
    await expect(index.client.memory.remove({ documentId: "doc-1" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(index.memory.remove).not.toHaveBeenCalled();

    const foreign = memoryClient(null);
    await expect(foreign.client.memory.remove({ documentId: "doc-2" })).rejects.toBeTruthy();
    expect(foreign.memory.remove).not.toHaveBeenCalled();
  });
});
