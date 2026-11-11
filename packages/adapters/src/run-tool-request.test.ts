import { describe, expect, it, vi } from "vitest";
import { relabelVaultItem, storeBotSecret } from "./bot-secrets.js";
import { fakeDatabase } from "./bot-secrets.test-support.js";
import type { ToolRequest } from "./run-tool-request.js";
import { prepareToolRequest } from "./run-tool-request.js";
import { EncryptedSecretStore } from "./secrets.js";
import { LOGIN_CODE_FIELD } from "./vault-card-use.js";

function ownBotUpdateCall() {
  const ctx = {
    deps: {
      prisma: {
        bot: {
          findUnique: async () => ({
            fleetManagement: true,
            modelProvider: "openrouter",
            modelId: "current-model",
          }),
          findUniqueOrThrow: async () => ({ instructions: "" }),
        },
      },
    },
    run: { trigger: "user", threadId: "thread-1" },
    bot: { id: "bot-1" },
    source: { ownerStartedRun: true },
    state: { tainted: true, earlierAttempt: Promise.resolve(false) },
    trust: {
      loadAutoReviewPreference: async () => ({ enabled: true, skipApprovals: false }),
      receivedOutsideMessage: async () => false,
    },
    secrets: [],
  };
  const request: ToolRequest = {
    name: "update_bot",
    args: { model: "test-model" },
    executionId: JSON.stringify(["pi-tool", "main", "call-1"]),
    connectorCall: {
      tool: "update_bot",
      args: { model: "test-model" },
      executionId: JSON.stringify(["pi-tool", "main", "call-1"]),
      route: undefined,
    },
    effectRequest: { model: "test-model" },
    resolvedTool: undefined,
    catalogRemapped: false,
    nextApprovedTool: undefined,
    approvedEffectKey: undefined,
    replayEffectToolName: "update_bot",
    fleetSummary: undefined,
    heldForApproval: false,
    purchase: undefined,
    cardUse: undefined,
    loginUse: undefined,
  };
  return { ctx, request: () => structuredClone(request) };
}

describe("prepareToolRequest: update_bot owner settings after outside content", () => {
  it("refuses once, then ends the turn instead of repeating the refusal", async () => {
    const { ctx, request } = ownBotUpdateCall();
    await expect(prepareToolRequest(ctx as never, request())).resolves.toEqual({
      error: expect.stringContaining("outside content"),
    });
    const repeat = await prepareToolRequest(ctx as never, request());
    expect(repeat).toMatchObject({
      kind: "agent_tool_result",
      terminate: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining("Settings"),
        },
      ],
    });
    expect(JSON.stringify(repeat)).not.toContain("outside content");
  });

  it("keeps preparing the change while the run is untainted", async () => {
    const { ctx, request } = ownBotUpdateCall();
    ctx.state.tainted = false;
    for (let index = 0; index < 3; index += 1) {
      await expect(prepareToolRequest(ctx as never, request())).resolves.toBeUndefined();
    }
  });
});

describe("private task tools after shared-channel messages", () => {
  it.each([
    "schedule_create",
    "schedule_list",
    "schedule_update",
    "schedule_cancel",
    "skill_read",
    "skill_create",
    "skill_update",
    "skill_delete",
  ])("refuses %s for original and claimed shared-channel messages", async (name) => {
    for (const originalChannel of [true, false]) {
      const ctx = {
        deps: {
          prisma: { steeringMessage: { findFirst: vi.fn(async () => ({ id: "claimed" })) } },
        },
        run: {},
        bot: {},
        runId: "run-1",
        source: { messagingChannelRun: originalChannel },
      };
      const request = { name, args: {}, executionId: "call-1" } as ToolRequest;
      await expect(prepareToolRequest(ctx as never, request)).resolves.toEqual({
        error: "This tool is unavailable after a shared-channel message.",
      });
    }
  });

  it.each(["user", "bot_message", "webhook"])(
    "keeps %s task tools available without a channel message",
    async (trigger) => {
      const ctx = {
        deps: { prisma: { steeringMessage: { findFirst: async () => null } } },
        run: { trigger },
        bot: {},
        runId: "run-1",
        source: { messagingChannelRun: false },
      };
      for (const name of ["schedule_update", "skill_read"]) {
        await expect(
          prepareToolRequest(
            ctx as never,
            { name, args: {}, executionId: "call-1" } as ToolRequest,
          ),
        ).resolves.toBeUndefined();
      }
    },
  );
});

describe("prepareToolRequest: a saved login that asks first", () => {
  const site = "https://login.example.test";
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");
  const owner = { userId: "user-1", spaceId: "space-1" };
  const fill = (secret: string, field: string) => ({
    kind: "fill_secret",
    ref: "e1",
    secret,
    field,
  });
  const main = JSON.stringify(["pi-tool", "main", "call-1"]);

  async function setup() {
    const db = fakeDatabase();
    const save = (name: string, policy: "allow" | "ask", fields: object[], origin = site) =>
      storeBotSecret({
        prisma: db.prisma,
        secretStore,
        scope: owner,
        destination: { name, origin, auth: { type: "login" } },
        plaintext: JSON.stringify({ fields }),
        policy,
      });
    const email = { label: "Email", value: "alice@example.test", hidden: false };
    const password = { label: "Password", value: "fake-password-1", hidden: true };
    await save("work", "ask", [email, password]);
    await save(
      "pin",
      "ask",
      [{ label: "PIN", value: "1234", hidden: true }],
      "https://pin.example.test",
    );
    await save("plain", "allow", [email, password]);
    await storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope: owner,
      destination: { name: "visa", origin: "", auth: { type: "card" } },
      plaintext: '{"number":"4242424242424242","expMonth":8,"expYear":2030,"cvc":"737"}',
    });
    Object.assign(db.prisma.secret, { findFirst: async () => null });
    const savedAt = db
      .rows()
      .find((row) => row.name === "work")!
      .updatedAt!.toISOString();
    const ctx = (trigger = "user", ownerStartedRun = true) => ({
      deps: { prisma: db.prisma, secretStore },
      run: { ...owner, botId: "bot-1", id: "run-1", trigger, threadId: "thread-1" },
      runId: "run-1",
      bot: { id: "bot-1" },
      source: { ownerStartedRun },
      providers: { browser: {} },
      computer: { pageBrowserAllowed: false, heldForTakeover: false },
      state: { walletHosts: new Set<string>() },
      context: { signal: new AbortController().signal },
      secrets: [],
    });
    const request = (
      args: Record<string, unknown>,
      change: Partial<ToolRequest> = {},
    ): ToolRequest => ({
      name: "browser_act",
      args,
      executionId: main,
      connectorCall: { tool: "browser_act", args, executionId: main, route: undefined },
      effectRequest: undefined,
      resolvedTool: undefined,
      catalogRemapped: false,
      nextApprovedTool: undefined,
      approvedEffectKey: undefined,
      replayEffectToolName: "browser_act",
      fleetSummary: undefined,
      heldForApproval: false,
      purchase: undefined,
      cardUse: undefined,
      loginUse: undefined,
      ...change,
    });
    const approval = {
      kind: "login",
      login: "work",
      site,
      title: "login.example.test",
      fields: ["Email", "Password"],
      savedAt,
    };
    return { db, ctx, request, approval };
  }

  it("asks for its authenticator code too, on whichever of its sites the page is on", async () => {
    const { db, ctx, request, approval } = await setup();
    const other = "https://www.login.example.test";
    await relabelVaultItem(db.prisma, owner, "work", { alsoOn: [other] });
    const savedAt = db
      .rows()
      .find((row) => row.name === "work")!
      .updatedAt!.toISOString();
    const code = { kind: "fill_code", ref: "e2", secret: "work" };
    const onPage = (pageUrl: string) => {
      const run = ctx();
      return { ...run, state: { ...run.state, pageUrl } };
    };
    const both = request({ actions: [fill("work", "Password"), code] });
    expect(await prepareToolRequest(onPage(`${other}/login`) as never, both)).toBeUndefined();
    expect(both.loginUse).toEqual({
      ...approval,
      site: other,
      fields: ["Password", LOGIN_CODE_FIELD],
      savedAt,
    });
    expect(both.fleetSummary).toMatchObject({ title: expect.stringContaining(" www.login.") });
    // A code alone asks too; a page on no site of the login names its own site.
    const alone = request({ actions: [code] });
    expect(
      await prepareToolRequest(onPage("https://evil.example.test/") as never, alone),
    ).toBeUndefined();
    expect(alone.loginUse).toEqual({ ...approval, fields: [LOGIN_CODE_FIELD], savedAt });
  });

  it("asks once for every field one call fills, from the saved login, never a forged approval", async () => {
    const { ctx, request, approval } = await setup();
    const actions = [fill("work", "Email"), fill("work", "Password")];
    const forged = { ...approval, fields: ["Email"], savedAt: "2020-01-01T00:00:00.000Z" };
    // Asking needs only what is saved about the login, never its decrypted value.
    const load = vi.spyOn(secretStore, "load");
    for (const args of [{ actions }, { actions, loginApproval: forged }]) {
      const prepared = request(args);
      expect(await prepareToolRequest(ctx() as never, prepared)).toBeUndefined();
      expect(prepared.loginUse).toEqual(approval);
      expect(prepared.args).toEqual({ actions, loginApproval: approval });
      expect(prepared.effectRequest).toEqual(prepared.args);
      expect(prepared.fleetSummary).toEqual({
        onceOnly: true,
        // Its title, never a username others in a shared chat could read.
        title: "Sign in to login.example.test with login.example.test?",
        lines: [],
      });
    }
    expect(load).not.toHaveBeenCalled();
    load.mockRestore();
    // A login that doesn't ask first needs no approval, and a forged one is dropped.
    const plain = request({ actions: [fill("plain", "Password")], loginApproval: forged });
    expect(await prepareToolRequest(ctx() as never, plain)).toBeUndefined();
    expect(plain.loginUse).toBeUndefined();
    expect(plain.args).toEqual({ actions: [fill("plain", "Password")] });
  });

  it.each(["http://login.example.test", "not a site"])(
    "asks nothing for a login saved at %s, which no fill types",
    async (origin) => {
      const { db, ctx, request, approval } = await setup();
      // Saved under older rules or changed by hand: no approval could name it on replay.
      db.rows().find((row) => row.name === "work")!.origin = origin;
      const actions = [fill("work", "Password")];
      const prepared = request({ actions });
      expect(await prepareToolRequest(ctx() as never, prepared)).toBeUndefined();
      expect(prepared.loginUse).toBeUndefined();
      // A replay carrying an approval for it passes none on: the tool and the effect get only
      // what was asked for.
      const replay = request(
        { actions, loginApproval: { ...approval, fields: ["Password"] } },
        { nextApprovedTool: "browser_act" },
      );
      expect(await prepareToolRequest(ctx() as never, replay)).toBeUndefined();
      expect(replay.loginUse).toBeUndefined();
      expect(replay.args).toEqual({ actions });
      expect(replay.effectRequest).toEqual({ actions });
    },
  );

  it("keeps an approval only for the replay of what the user approved", async () => {
    const { ctx, request, approval } = await setup();
    const actions = [fill("work", "Email"), fill("work", "Password")];
    const replay = request(
      { actions, loginApproval: approval },
      { nextApprovedTool: "browser_act" },
    );
    expect(await prepareToolRequest(ctx() as never, replay)).toBeUndefined();
    expect(replay.loginUse).toEqual(approval);
    // Approved for the password only, a call that also fills the email is not covered.
    const wider = request(
      { actions, loginApproval: { ...approval, fields: ["Password"] } },
      { nextApprovedTool: "browser_act" },
    );
    expect(await prepareToolRequest(ctx() as never, wider)).toEqual({
      error: expect.stringContaining("not approved"),
    });
    // Approved for another reason while the login was Allow, then set to Ask first while the card
    // waited: the replay carries no sign-in approval, so it is refused and asks again.
    const unasked = request({ actions }, { nextApprovedTool: "browser_act" });
    expect(await prepareToolRequest(ctx() as never, unasked)).toEqual({
      error: expect.stringContaining("Call the tool again; that asks the user."),
    });
    expect(unasked.loginUse).toBeUndefined();
    expect(unasked.args).not.toHaveProperty("loginApproval");
  });

  it("signs in with one login that asks per call, and never with a saved card", async () => {
    const { ctx, request } = await setup();
    expect(
      await prepareToolRequest(
        ctx() as never,
        request({ actions: [fill("work", "Password"), fill("pin", "PIN")] }),
      ),
    ).toEqual({ error: expect.stringContaining("one saved login") });
    expect(
      await prepareToolRequest(
        ctx() as never,
        request({
          actions: [
            fill("work", "Password"),
            {
              kind: "fill_card",
              ref: "e2",
              card: "visa",
              site: "https://shop.example.test",
              field: "number",
            },
          ],
        }),
      ),
    ).toEqual({ error: expect.stringContaining("separate browser_act calls") });
  });

  it("signs in and pays in separate calls, whether the purchase check finds one or fails", async () => {
    const { ctx, request } = await setup();
    const found = {
      steps: [],
      site: "shop.example.test",
      label: "Pay",
      amount: "$5",
      amountSource: "page",
    };
    for (const purchaseCheck of [
      async () => ({ purchase: found }),
      async () => {
        throw new Error("page gone");
      },
    ]) {
      const paying = {
        ...ctx(),
        providers: { browser: { purchaseCheck } },
        computer: { pageBrowserAllowed: true, heldForTakeover: false, get: async () => ({}) },
      };
      const prepared = request({
        actions: [fill("work", "Password"), { kind: "click", ref: "e2" }],
      });
      expect(await prepareToolRequest(paying as never, prepared)).toEqual({
        error: expect.stringContaining("separate browser_act calls"),
      });
      expect(prepared.loginUse).toBeUndefined();
      expect(prepared.purchase).toBeUndefined();
      expect(prepared.args).not.toHaveProperty("loginApproval");
    }
  });

  it.each([
    "routine",
    "webhook",
    "spawn",
    "bot_message",
    "messaging",
    "cloud_agent",
    "skill",
    "purchase",
    "resume",
    "reaction",
    "media",
  ])(
    "asks for it in a %s run, as for a saved card; the gate decides who can answer",
    async (trigger) => {
      const { ctx, request, approval } = await setup();
      for (const executionId of [main, JSON.stringify(["pi-tool", "helper-1", "call-1"])]) {
        const prepared = request({ actions: [fill("work", "Password")] }, { executionId });
        expect(await prepareToolRequest(ctx(trigger, false) as never, prepared)).toBeUndefined();
        expect(prepared.loginUse).toEqual({ ...approval, fields: ["Password"] });
      }
    },
  );
});
