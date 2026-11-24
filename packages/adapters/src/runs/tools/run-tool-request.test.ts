import { ROUTINE_NAME_MAX_LENGTH } from "@rakazo/contracts";
import { REDACTED_MARKER } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApprovalAskBlock } from "../../approvals/approval-ask.js";
import { relabelVaultItem, resolveLoginFill, storeBotSecret } from "../../secrets/bot-secrets.js";
import { fakeDatabase } from "../../secrets/bot-secrets.test-support.js";
import { EncryptedSecretStore } from "../../secrets/secrets.js";
import { LOGIN_CODE_FIELD, vaultLoginUseOf } from "../../secrets/vault/vault-card-use.js";
import type { ToolRequest } from "./run-tool-request.js";
import { prepareScheduleUpdateApproval, prepareToolRequest } from "./run-tool-request.js";
import { taskTools } from "./run-tools-tasks.js";

// RFC 6238's test key, written in pieces so it never reads as a saved secret.
const TEST_KEY = ("GEZDGNBV" + "GY3TQOJQ").repeat(2);

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
    settingsChange: false,
    ignoresAllowRules: false,
    purchase: undefined,
    cardUse: undefined,
    loginUse: undefined,
  };
  return { ctx, request: () => structuredClone(request) };
}

describe("prepareToolRequest: update_bot owner settings after outside content", () => {
  it("prepares the change and marks it for the approval model to check", async () => {
    const { ctx, request } = ownBotUpdateCall();
    const prepared = request();
    await expect(prepareToolRequest(ctx as never, prepared)).resolves.toBeUndefined();
    expect(prepared.settingsChange).toBe(true);
  });

  it("keeps preparing the change while the run is untainted", async () => {
    const { ctx, request } = ownBotUpdateCall();
    ctx.state.tainted = false;
    for (let index = 0; index < 3; index += 1) {
      await expect(prepareToolRequest(ctx as never, request())).resolves.toBeUndefined();
    }
  });
});

describe("prepareToolRequest: after the bot archived itself", () => {
  const archived = { error: "You are archived, so no more tools can run. Send your reply." };
  function call(name: string, args: Record<string, unknown>) {
    const { ctx, request } = ownBotUpdateCall();
    Object.assign(ctx.bot, { name: "Scout" });
    Object.assign(ctx.state, { selfArchived: true });
    return prepareToolRequest(ctx as never, { ...request(), name, args });
  }

  it("refuses every other tool, including archiving another bot", async () => {
    await expect(call("message_user", { text: "Done" })).resolves.toEqual(archived);
    await expect(call("run_subagent", { task: "More work" })).resolves.toEqual(archived);
    await expect(call("archive_bot", { confirm_name: "Peer", bot_id: "peer-1" })).resolves.toEqual(
      archived,
    );
    await expect(call("archive_bot", { confirm_name: "Peer" })).resolves.toEqual(archived);
  });

  it("still lets a retried archive of itself reconcile", async () => {
    await expect(call("archive_bot", { confirm_name: "Scout" })).resolves.not.toEqual(archived);
    await expect(
      call("archive_bot", { confirm_name: "Scout", bot_id: "bot-1" }),
    ).resolves.not.toEqual(archived);
    await expect(call("archive_bot", { confirm_name: "Scout", bot_id: "" })).resolves.not.toEqual(
      archived,
    );
  });

  it("refuses on a resumed run whose bot is already archived", async () => {
    const { ctx, request } = ownBotUpdateCall();
    Object.assign(ctx.bot, { name: "Scout", archivedAt: new Date("2026-11-23T12:00:00.000Z") });
    await expect(prepareToolRequest(ctx as never, request())).resolves.toEqual(archived);
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
    "remove_mcp_server",
  ])("refuses %s for original and claimed shared-channel messages", async (name) => {
    for (const originalChannel of [true, false]) {
      const ctx = {
        deps: {
          prisma: { steeringMessage: { findFirst: vi.fn(async () => ({ id: "claimed" })) } },
        },
        run: {},
        bot: {},
        state: {},
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
        thread: { id: "thread-1", groupId: null },
        state: {},
        runId: "run-1",
        source: { messagingChannelRun: false },
      };
      for (const name of ["schedule_update", "skill_read"]) {
        const prepared = await prepareToolRequest(
          ctx as never,
          { name, args: {}, executionId: "call-1" } as ToolRequest,
        );
        expect(prepared).toBeUndefined();
      }
    },
  );
});

describe("schedule tools on another bot's routines", () => {
  function managedRoutineCall(input: {
    fleetManagement?: boolean;
    ownerStartedRun?: boolean;
    outsideMessage?: boolean;
    trigger?: string;
  }) {
    const ctx = {
      deps: {
        prisma: {
          steeringMessage: { findFirst: async () => null },
          bot: {
            findUnique: async () => ({ fleetManagement: input.fleetManagement ?? true }),
            findMany: async ({ where }: { where: { id?: string; name?: string } }) =>
              [
                { id: "child", name: "Child" },
                { id: "bot-1", name: "Me" },
              ].filter((row) => (where.id ? row.id === where.id : row.name === where.name)),
          },
        },
      },
      run: { trigger: input.trigger ?? "user", spaceId: "space-1", userId: "user-1" },
      fleetRun: { spaceId: "space-1" },
      bot: { id: "bot-1", name: "Me" },
      thread: { id: "thread-1", groupId: null },
      state: {},
      runId: "run-1",
      secrets: [],
      source: { messagingChannelRun: false, ownerStartedRun: input.ownerStartedRun ?? true },
      trust: { receivedOutsideMessage: async () => input.outsideMessage ?? false },
    };
    return (name: string, args: Record<string, unknown>) => {
      const request = { name, args, executionId: "call-1" } as ToolRequest;
      return { prepared: prepareToolRequest(ctx as never, request), request };
    };
  }

  it.each(["schedule_list", "schedule_update", "schedule_cancel"])(
    "%s needs bot management and a run the owner started",
    async (name) => {
      const off = managedRoutineCall({ fleetManagement: false })(name, { bot_name: "Child" });
      await expect(off.prepared).resolves.toEqual({
        error: "Bot management is off for this bot, so it reaches only its own routines.",
      });
      const fromOthers = managedRoutineCall({ ownerStartedRun: false })(name, { bot_id: "child" });
      await expect(fromOthers.prepared).resolves.toEqual({
        error: "Bot management tools need a run you started.",
      });
      const own = managedRoutineCall({ fleetManagement: false })(
        name,
        name === "schedule_update" ? { routineId: "r", active: false } : { routineId: "r" },
      );
      await expect(own.prepared).resolves.toBeUndefined();
    },
  );

  it("acts on the named bot's id, and treats passing its own id as its own routines", async () => {
    const byName = managedRoutineCall({})("schedule_cancel", { bot_name: "Child", name: "r" });
    await expect(byName.prepared).resolves.toBeUndefined();
    expect(byName.request.args).toEqual({ bot_id: "child", bot_name: "Child", name: "r" });
    const self = managedRoutineCall({ fleetManagement: false })("schedule_update", {
      bot_id: " bot-1 ",
      routineId: "r",
      active: false,
    });
    await expect(self.prepared).resolves.toBeUndefined();
    expect(self.request.args).toEqual({ routineId: "r", active: false });
  });

  it("holds a change for approval once outside text reached the run, and never a list", async () => {
    const call = managedRoutineCall({ outsideMessage: true });
    for (const name of ["schedule_update", "schedule_cancel"]) {
      const { prepared, request } = call(name, {
        bot_id: "child",
        routineId: "r",
        ...(name === "schedule_update" ? { active: false } : {}),
      });
      await expect(prepared).resolves.toBeUndefined();
      expect(request).toMatchObject({ heldForApproval: true, ignoresAllowRules: true });
    }
    const list = call("schedule_list", { bot_id: "child" });
    await expect(list.prepared).resolves.toBeUndefined();
    expect(list.request.heldForApproval).toBeUndefined();
  });

  it.each(["webhook", "bot_message", "spawn", "tickets"])(
    "holds a %s run's change to, or list of, another bot's routines for the owner",
    async (trigger) => {
      const call = managedRoutineCall({ ownerStartedRun: false, trigger });
      for (const name of ["schedule_cancel", "schedule_list"]) {
        const { prepared, request } = call(name, { bot_id: "child", routineId: "r" });
        await expect(prepared).resolves.toBeUndefined();
        expect(request).toMatchObject({ heldForApproval: true, ignoresAllowRules: true });
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
      settingsChange: false,
      ignoresAllowRules: false,
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

  it("signs in and pays in separate calls, and signs in nowhere when the check fails", async () => {
    const { ctx, request } = await setup();
    const found = {
      steps: [],
      site: "shop.example.test",
      label: "Pay",
      amount: "$5",
      amountSource: "page",
    };
    for (const [purchaseCheck, error] of [
      [async () => ({ purchase: found }), "separate browser_act calls"],
      [
        async () => {
          throw new Error("page gone");
        },
        "couldn't be read",
      ],
    ] as const) {
      const paying = {
        ...ctx(),
        providers: { browser: { purchaseCheck } },
        computer: { pageBrowserAllowed: true, heldForTakeover: false, get: async () => ({}) },
      };
      const prepared = request({
        actions: [fill("work", "Password"), { kind: "click", ref: "e2" }],
      });
      expect(await prepareToolRequest(paying as never, prepared)).toEqual({
        error: expect.stringContaining(error),
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

  describe("what its card says, and what allowing it then lets the call type", () => {
    const question = "Sign in to login.example.test with login.example.test?";
    const typesCode = "This types the login's authenticator code.";
    const other = "https://www.login.example.test";
    const password = fill("work", "Password");
    const code = { kind: "fill_code", ref: "e2", secret: "work" };
    const notAllowed = "has not approved signing in with this login here";
    type Db = Awaited<ReturnType<typeof setup>>["db"];

    /** The `work` login, saved again as the row says, in the account vault or the Space's own. */
    async function saved(login: {
      policy?: "allow" | "ask" | "off";
      key?: boolean;
      ownVault?: boolean;
      alsoOn?: string[];
    }) {
      const made = await setup();
      if (login.ownVault) made.db.useOwnVault("space-1");
      const save = (key = login.key) =>
        storeBotSecret({
          prisma: made.db.prisma,
          secretStore,
          scope: owner,
          destination: { name: "work", origin: site, auth: { type: "login" } },
          plaintext: JSON.stringify({
            fields: [{ label: "Password", value: "fake-password-1", hidden: true }],
            ...(key ? { otp: TEST_KEY } : {}),
          }),
          policy: login.policy ?? "ask",
          alsoOn: login.alsoOn ?? [],
        });
      await save();
      return { ...made, addKey: () => save(true) };
    }

    it.each<{
      name: string;
      login: Parameters<typeof saved>[0];
      actions: object[];
      /** Where the page is when the call is made, and when the answer is replayed. */
      page?: string;
      later?: string;
      /** What the owner does between the card and the replay. */
      meanwhile?: (made: { db: Db; addKey: () => Promise<unknown> }) => Promise<unknown>;
      /** The card's detail under its question, or no card at all. */
      card: string | undefined;
      /** What the replay types of the password and of the code: a site, or why nothing. */
      types: [string, string];
    }>([
      {
        name: "the password of a login with no key",
        login: {},
        actions: [password],
        card: "",
        types: [site, notAllowed],
      },
      {
        name: "the password and code of a login with no key",
        login: {},
        actions: [password, code],
        card: typesCode,
        types: [site, "no authenticator key"],
      },
      {
        name: "the password alone of a login with a key",
        login: { key: true },
        actions: [password],
        card: "",
        types: [site, notAllowed],
      },
      {
        name: "the password and code of a login with a key",
        login: { key: true },
        actions: [password, code],
        card: typesCode,
        types: [site, site],
      },
      {
        name: "the code alone, with no approval before it",
        login: { key: true },
        actions: [code],
        card: typesCode,
        types: [notAllowed, site],
      },
      {
        name: "a password allowed before the owner adds a key",
        login: {},
        actions: [password],
        meanwhile: ({ addKey }) => addKey(),
        card: "",
        types: ["changed after the user approved it", notAllowed],
      },
      {
        name: "a sign-in allowed on one site, replayed with the page on another of its sites",
        login: { key: true, alsoOn: [other] },
        actions: [password, code],
        later: `${other}/login`,
        card: typesCode,
        types: [site, site],
      },
      {
        name: "a sign-in allowed on a site the owner then takes off the login",
        login: { key: true, alsoOn: [other] },
        actions: [password, code],
        page: `${other}/login`,
        meanwhile: ({ db }) => relabelVaultItem(db.prisma, owner, "work", { alsoOn: [] }),
        card: typesCode,
        types: [notAllowed, notAllowed],
      },
      {
        name: "a login in the Space's own vault",
        login: { key: true, ownVault: true },
        actions: [password, code],
        card: typesCode,
        types: [site, site],
      },
      {
        name: "a login set to Allow, which asks nothing",
        login: { policy: "allow", key: true },
        actions: [password, code],
        card: undefined,
        types: [site, site],
      },
      {
        name: "a login set to Block, which asks nothing and types nothing",
        login: { policy: "off", key: true },
        actions: [password, code],
        card: undefined,
        types: ["Login is unavailable", "Login is unavailable"],
      },
    ])("$name", async ({ login, actions, page, later, meanwhile, card, types }) => {
      const made = await saved(login);
      const run = made.ctx();
      const asked = made.request({ actions });
      expect(
        await prepareToolRequest(
          { ...run, state: { ...run.state, pageUrl: page } } as never,
          asked,
        ),
      ).toBeUndefined();
      // The card as every app gets it: one block, built from what the answer will be kept as.
      const block =
        asked.fleetSummary &&
        buildApprovalAskBlock("effect-1", "browser_act", asked.args, [], {
          summary: asked.fleetSummary,
        });
      const host = new URL(page ?? site).host;
      expect(block).toEqual(
        card === undefined
          ? undefined
          : expect.objectContaining({
              text: question.replace("Sign in to login.example.test", `Sign in to ${host}`),
              detail: card,
              detailFormat: "text",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            }),
      );
      await meanwhile?.(made);
      // The replay of the allowed call types only what its stored approval names.
      const approval = vaultLoginUseOf(asked.args.loginApproval);
      const typed = async (field: string) => {
        const fill = await resolveLoginFill({
          prisma: made.db.prisma,
          secretStore,
          scope: { ...owner, botId: "bot-1" },
          runId: "run-1",
          name: "work",
          field,
          ...(field === LOGIN_CODE_FIELD ? { code: true as const } : {}),
          approval,
          pageUrl: later ?? page,
        });
        return "error" in fill ? fill.error : fill.origin;
      };
      const [passwordTyped, codeTyped] = types;
      expect(await typed("Password")).toContain(passwordTyped);
      expect(await typed(LOGIN_CODE_FIELD)).toContain(codeTyped);
    });

    it("leaves the card for a saved card as it was", async () => {
      const { ctx, request } = await setup();
      const paying = request({
        actions: [
          {
            kind: "fill_card",
            card: "visa",
            site: "https://shop.example.test",
            field: "number",
          },
        ],
      });
      expect(await prepareToolRequest(ctx() as never, paying)).toBeUndefined();
      expect(paying.fleetSummary).toEqual({
        onceOnly: true,
        title: "Pay with Visa ·· 4242 on shop.example.test?",
        lines: [],
      });
    });
  });
});

describe("the user's computer after a routine or webhook joined the run", () => {
  function userComputerCall(claimed: boolean) {
    const findFirst = vi.fn(async (_query: { where: Record<string, unknown> }) =>
      claimed ? { id: "steering-1" } : null,
    );
    const ctx = {
      deps: { prisma: { steeringMessage: { findFirst } }, userDevices: {} },
      run: { trigger: "user" },
      bot: {},
      state: {},
      runId: "run-1",
      source: { messagingChannelRun: false, userComputerOwner: "user-1" },
    };
    const request = {
      name: "user_computer_shell",
      args: {},
      executionId: JSON.stringify(["pi-tool", "main", "call-1"]),
    } as ToolRequest;
    return { ctx, request, findFirst };
  }

  it("refuses once the run has read a handed-over routine or webhook task", async () => {
    const { ctx, request, findFirst } = userComputerCall(true);
    await expect(prepareToolRequest(ctx as never, request)).resolves.toEqual({
      error: "The user's computer is not available in this run.",
    });
    expect(findFirst.mock.calls.at(-1)?.[0].where).toEqual({
      runId: "run-1",
      claimedAt: { not: null },
      originTrigger: { in: ["routine", "webhook"] },
    });
  });

  it("stays available in the owner's own run", async () => {
    const { ctx, request } = userComputerCall(false);
    await expect(prepareToolRequest(ctx as never, request)).resolves.toBeUndefined();
  });
});

describe("a schedule_update that needs an approval preview", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-20T00:00:00.000Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const owner = "user-1";
  const weekly = {
    id: "routine-1",
    spaceId: "space-1",
    threadId: "thread-1",
    userId: owner,
    name: "Groceries",
    prompt: "Order the usual groceries",
    crons: ["0 10 * * 1"],
    timezone: "Europe/Berlin",
    active: true,
    watch: null,
    nextRunAt: new Date("2026-10-26T09:00:00.000Z"),
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    emailSenders: null,
  };
  /** A watch has no schedule: it checks for changes every so many minutes. */
  const watching = {
    ...weekly,
    crons: [],
    timezone: "UTC",
    watch: { kind: "files", paths: ["inbox"], everyMinutes: 60, loud: false },
  };

  /** `routine` is the stored row, or a function giving it, for a row that moves during the test. */
  function updateCall(
    args: Record<string, unknown>,
    routine: unknown = weekly,
    secrets: string[] = [],
  ) {
    const stored = () => (typeof routine === "function" ? routine() : routine);
    const ctx = {
      deps: {
        prisma: {
          routine: {
            findFirst: vi.fn(async () => stored()),
            updateMany: vi.fn(async () => ({ count: 1 })),
          },
          bot: { findFirst: vi.fn(async () => ({ id: "bot-1", userId: owner })) },
          steeringMessage: { findFirst: vi.fn(async () => null) },
        },
        jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
        events: { append: vi.fn(async () => undefined) },
        secretStore: { put: vi.fn(async () => undefined) },
      },
      run: { spaceId: "space-1", userId: owner, trigger: "user" },
      fleetRun: { spaceId: "space-1" },
      bot: { id: "bot-1", name: "Me" },
      state: {},
      thread: { id: "thread-1", groupId: null },
      runId: "run-1",
      source: { messagingChannelRun: false, ownerStartedRun: true },
      trust: { receivedOutsideMessage: async () => false },
      secrets,
    };
    const request = {
      name: "schedule_update",
      args,
      effectRequest: args,
      executionId: "call-1",
      nextApprovedTool: undefined,
    } as ToolRequest;
    const updateMany = ctx.deps.prisma.routine.updateMany;
    return { ctx, request, updateMany };
  }

  it("shows both versions of an edited prompt and pins the old prompt", async () => {
    const { ctx, request } = updateCall({ routineId: "routine-1", prompt: "Order less" });
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
    expect(request.fleetSummary).toEqual({
      title: "Update “Groceries”?",
      lines: ["Instructions: Order less", "Previously: Order the usual groceries"],
      routineUpdate: {
        changes: [{ field: "prompt", before: "Order the usual groceries", after: "Order less" }],
      },
    });
    // The card lists what the model sent; the approved call replays with the baseline beside it.
    expect(request.args).toEqual({ routineId: "routine-1", prompt: "Order less" });
    expect(request.effectRequest).toEqual({
      routineId: "routine-1",
      prompt: "Order less",
      expected: { prompt: "Order the usual groceries" },
    });
  });

  it("keeps a multiline prompt inside its field on the plain-text card", async () => {
    const { ctx, request } = updateCall({
      routineId: "routine-1",
      prompt: "Order less\r\nStatus: Active\u2028Schedule: Every day",
    });
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
    expect(request.fleetSummary?.lines).toEqual([
      "Instructions: Order less\n    Status: Active\n    Schedule: Every day",
      "Previously: Order the usual groceries",
    ]);
  });

  it("shows a pause as a status change", async () => {
    const { ctx, request } = updateCall({ routineId: "routine-1", active: false });
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
    expect(request.fleetSummary?.routineUpdate?.changes).toEqual([
      { field: "active", before: true, after: false },
    ]);
  });

  it("shows a resume as the active change alone, since the save picks its next run then", async () => {
    const { ctx, request } = updateCall(
      { routineId: "routine-1", active: true },
      { ...weekly, active: false, nextRunAt: null },
    );
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
    expect(request.fleetSummary?.routineUpdate?.changes).toEqual([
      { field: "active", before: false, after: true },
    ]);
    expect(request.args).not.toHaveProperty("expected");
  });

  it("shows a retime as the schedule and the next run it moves to", async () => {
    const { ctx, request } = updateCall({
      routineId: "routine-1",
      cron: "0 9 * * 1",
      startAt: "2026-11-02",
    });
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
    expect(request.fleetSummary?.lines).toEqual([
      "Schedule: Every Monday at 9:00 AM",
      "Previously: Every Monday at 10:00 AM",
      "Next run: Monday, 2026-11-02 09:00 (UTC+01:00)",
      "Previously: Monday, 2026-10-26 10:00 (UTC+01:00)",
    ]);
  });

  it("shows a moved first run as the next run it moves to", async () => {
    const { ctx, request } = updateCall({ routineId: "routine-1", startAt: "2026-11-02" });
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
    expect(request.fleetSummary?.lines).toEqual([
      "Next run: Monday, 2026-11-02 10:00 (UTC+01:00)",
      "Previously: Monday, 2026-10-26 10:00 (UTC+01:00)",
    ]);
  });

  it("shows a retime without a start as the schedule alone, since the save picks its first run then", async () => {
    const { ctx, request } = updateCall({ routineId: "routine-1", cron: "0 9 * * 1" });
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
    expect(request.fleetSummary?.lines).toEqual([
      "Schedule: Every Monday at 9:00 AM",
      "Previously: Every Monday at 10:00 AM",
    ]);
  });

  it("keeps the plain card for an events edit and for a watch interval edit", async () => {
    // Each is one whole argument of the call, which the plain card lists as it was sent.
    const events = updateCall({ routineId: "routine-1", on: { webhook: true } });
    await expect(
      prepareScheduleUpdateApproval(events.ctx as never, events.request),
    ).resolves.toBeUndefined();
    expect(events.request.fleetSummary).toBeUndefined();
    expect(events.request.args).toEqual({ routineId: "routine-1", on: { webhook: true } });

    const interval = updateCall({ routineId: "routine-1", everyMinutes: 30 }, watching);
    await expect(
      prepareScheduleUpdateApproval(interval.ctx as never, interval.request),
    ).resolves.toBeUndefined();
    expect(interval.request.fleetSummary).toBeUndefined();
    expect(interval.request.args).toEqual({ routineId: "routine-1", everyMinutes: 30 });
  });

  it("keeps the plain card for an end date edit, which the comparison has no line for", async () => {
    const args = { routineId: "routine-1", name: "Weekly shop", endAt: "2026-11-30" };
    const { ctx, request } = updateCall(args);
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
    // The comparison would show the new name alone, without the end the call sets beside it.
    expect(request.fleetSummary).toBeUndefined();
    expect(request.args).toEqual(args);
    expect(request.effectRequest).toEqual({ ...args, expected: { name: "Groceries" } });
  });

  it("refuses an events edit this server cannot make a webhook key for", async () => {
    const { ctx, request } = updateCall({ routineId: "routine-1", on: { webhook: true } });
    const noKeyStore = { ...ctx, deps: { ...ctx.deps, secretStore: undefined } };
    await expect(prepareScheduleUpdateApproval(noKeyStore as never, request)).resolves.toEqual({
      error: "Webhook keys are not available on this server.",
    });
    expect(ctx.deps.events.append).not.toHaveBeenCalled();
  });

  it("lists a prompt edit after the other changes, so a long one cannot push them off the card", async () => {
    const { ctx, request } = updateCall({
      routineId: "routine-1",
      prompt: "x".repeat(2_600),
      active: false,
    });
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
    expect(request.fleetSummary?.routineUpdate?.changes).toEqual([
      { field: "active", before: true, after: false },
      { field: "prompt", before: "Order the usual groceries", after: "x".repeat(2_600) },
    ]);
  });

  it("keeps the plain card for a change too long for the comparison, so the whole new prompt stays on it", async () => {
    const prompt = "x".repeat(3_600);
    const { ctx, request } = updateCall({ routineId: "routine-1", prompt });
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
    // The comparison would cut the new prompt at its end; the plain card gives it the whole length.
    expect(request.fleetSummary).toBeUndefined();
    expect(request.args).toEqual({ routineId: "routine-1", prompt });
    expect(request.effectRequest).toMatchObject({
      prompt,
      expected: { prompt: "Order the usual groceries" },
    });
  });

  it("keeps the plain card for a comparison that redaction would lengthen past the card", async () => {
    // A one-character secret grows into a ten-character marker each time it appears.
    const args = { routineId: "routine-1", prompt: "k".repeat(3_400) };
    const plain = updateCall(args, weekly, ["k"]);
    await expect(
      prepareScheduleUpdateApproval(plain.ctx as never, plain.request),
    ).resolves.toBeUndefined();
    expect(plain.request.fleetSummary).toBeUndefined();
    expect(plain.request.effectRequest).toMatchObject({
      expected: { prompt: "Order the usual groceries" },
    });
    // The same prompt leaves room for the comparison when nothing in it is a secret.
    const comparison = updateCall(args);
    await expect(
      prepareScheduleUpdateApproval(comparison.ctx as never, comparison.request),
    ).resolves.toBeUndefined();
    expect(comparison.request.fleetSummary?.routineUpdate?.changes[0]?.before).toBe(
      "Order the usual groceries",
    );
  });

  it.each([
    [
      "a delay, which the save counts from its own clock",
      { routineId: "routine-1", delayMinutes: 30, prompt: "Order less" },
      { prompt: "Order the usual groceries" },
    ],
    [
      "a call that changes nothing",
      { routineId: "routine-1", name: "Groceries" },
      { name: "Groceries" },
    ],
  ])(
    "keeps the plain card for %s, and still pins what it writes",
    async (_label, args, expected) => {
      const { ctx, request } = updateCall(args);
      await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
      expect(request.fleetSummary).toBeUndefined();
      expect(request.args).toEqual(args);
      expect(request.effectRequest).toEqual({ ...args, expected });
    },
  );

  it("fails the call when the preview cannot run, as the save would", async () => {
    const { ctx, request } = updateCall({ routineId: "routine-1", prompt: "Order less" });
    ctx.deps.prisma.routine.findFirst = vi.fn(async () => {
      throw new Error("The database is away.");
    });
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).rejects.toThrow(
      "The database is away.",
    );
  });

  it("previews without writing", async () => {
    const { ctx, request } = updateCall({
      routineId: "routine-1",
      prompt: "Order less",
      on: { webhook: true },
    });
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
    const { deps } = ctx;
    expect(deps.prisma.routine.updateMany).not.toHaveBeenCalled();
    expect(deps.secretStore?.put).not.toHaveBeenCalled();
    expect(deps.events.append).not.toHaveBeenCalled();
    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
    expect(deps.jobs.cancel).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a non-owner's edit of what the routine does",
      () => ({ ...weekly, userId: "user-2" }),
      { routineId: "routine-1", prompt: "Order less" },
      "Only the person who owns this routine can change it. You can still pause or resume it with active, or make the user their own copy with schedule_create.",
    ],
    [
      "a name past the length limit",
      () => weekly,
      { routineId: "routine-1", name: "x".repeat(ROUTINE_NAME_MAX_LENGTH + 1) },
      `name must be at most ${ROUTINE_NAME_MAX_LENGTH} characters.`,
    ],
    [
      "a call with nothing to update",
      () => weekly,
      { routineId: "routine-1" },
      "Nothing to update.",
    ],
    [
      "a retime of a watch",
      () => watching,
      { routineId: "routine-1", cron: "0 9 * * *" },
      "This routine is a watch: it has no schedule or timezone. Change how often it checks with everyMinutes instead; do not cancel and recreate it.",
    ],
    [
      "a watch set to run alongside its chat",
      () => watching,
      { routineId: "routine-1", inChat: true },
      "A schedule that watches for changes runs alongside its chat.",
    ],
    [
      "a one-time retime that keeps the routine's events",
      () => ({ ...weekly, webhookEnabled: true }),
      { routineId: "routine-1", runAt: "2027-01-01T09:00:00" },
      "A one-time schedule takes no events; remove them with on {} first.",
    ],
    [
      "a call for a routine that is not there",
      () => null,
      { routineId: "gone" },
      "Schedule not found.",
    ],
  ])("refuses %s before any card, as the save would", async (_label, routine, args, error) => {
    const { ctx, request } = updateCall(args, routine());
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toEqual({ error });
    expect(request.fleetSummary).toBeUndefined();
    expect(request.args).not.toHaveProperty("expected");
  });

  it("lets a non-owner pause the routine, which stays theirs to pause", async () => {
    const { ctx, request } = updateCall(
      { routineId: "routine-1", active: false },
      { ...weekly, userId: "user-2" },
    );
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
    expect(request.fleetSummary?.routineUpdate?.changes).toEqual([
      { field: "active", before: true, after: false },
    ]);
  });

  it("redacts a secret that spans lines in both versions of the instructions", async () => {
    // Each line of this secret is short and spaced, so only the whole value is protected.
    const secret = "user: alice\npass: s3cret";
    const { ctx, request } = updateCall(
      { routineId: "routine-1", prompt: `${secret}\nSummarize daily.` },
      { ...weekly, prompt: `${secret}\nSummarize weekly.` },
      [secret],
    );
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
    expect(request.fleetSummary?.routineUpdate?.changes).toEqual([
      {
        field: "prompt",
        before: `${REDACTED_MARKER}\nSummarize weekly.`,
        after: `${REDACTED_MARKER}\nSummarize daily.`,
      },
    ]);
    expect(JSON.stringify(request.fleetSummary)).not.toMatch(/s3cret|alice/);
  });

  it("redacts a secret that crosses the end of the clipped old prompt", async () => {
    const secret = "s3cr3t-token-value-1234";
    // The secret starts before the clip and ends after it.
    const { ctx, request } = updateCall(
      { routineId: "routine-1", prompt: "Order less" },
      { ...weekly, prompt: `${"x".repeat(790)}${secret}${"y".repeat(50)}` },
      [secret],
    );
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
    expect(request.fleetSummary?.routineUpdate?.changes[0]?.before).toBe(
      `${"x".repeat(790)}${REDACTED_MARKER}…`,
    );
    expect(JSON.stringify(request.fleetSummary)).not.toContain("s3cr3t");
  });

  it("redacts a secret in the routine's name before the title escapes it", async () => {
    // A card title escapes asterisks, which would break the secret apart before redaction.
    const { ctx, request } = updateCall(
      { routineId: "routine-1", prompt: "Order less" },
      { ...weekly, name: "Weekly *token* check" },
      ["*token*"],
    );
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
    expect(request.fleetSummary?.title).toContain("redacted");
    expect(request.fleetSummary?.title).not.toContain("*token*");
  });

  it("drops a model-supplied baseline and pins the row's value instead", async () => {
    const { ctx, request } = updateCall({
      routineId: "routine-1",
      prompt: "Order less",
      expected: { prompt: "Forged" },
    });
    await expect(prepareToolRequest(ctx as never, request)).resolves.toBeUndefined();
    expect(ctx.deps.prisma.routine.findFirst).not.toHaveBeenCalled();
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
    expect(request.args).toEqual({ routineId: "routine-1", prompt: "Order less" });
    expect(request.effectRequest).toMatchObject({
      expected: { prompt: "Order the usual groceries" },
    });
  });

  it("pins a prompt the call writes unchanged as the routine holds it, and that call saves", async () => {
    const { ctx, request } = updateCall(
      // Sent with surrounding spaces, which the save trims: the pin must be what is stored.
      { routineId: "routine-1", prompt: "  Order the usual groceries ", active: false },
    );
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
    expect(request.effectRequest).toMatchObject({
      expected: { prompt: "Order the usual groceries" },
    });
    const replay = {
      name: "schedule_update",
      args: request.effectRequest,
      finish: async (result: unknown) => result,
    } as never;
    await expect(taskTools.schedule_update!(ctx as never, replay)).resolves.toMatchObject({
      ok: true,
      changes: { active: { before: true, after: false } },
    });
  });

  it("answers a routine that moved after its plain card too, instead of overwriting it", async () => {
    let prompt = "Order the usual groceries";
    const { ctx, request, updateMany } = updateCall(
      { routineId: "routine-1", delayMinutes: 30, prompt: "Order less" },
      () => ({ ...weekly, prompt }),
    );
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
    expect(request.fleetSummary).toBeUndefined();
    prompt = "Edited elsewhere";
    const replay = {
      name: "schedule_update",
      args: request.effectRequest,
      finish: async (result: unknown) => result,
    } as never;
    await expect(taskTools.schedule_update!(ctx as never, replay)).resolves.toEqual({
      error: "The schedule changed while saving. Call schedule_list and try again.",
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("answers a routine that moved after its card, instead of overwriting it", async () => {
    let prompt = "Order the usual groceries";
    const { ctx, request, updateMany } = updateCall(
      { routineId: "routine-1", prompt: "Order less" },
      () => ({ ...weekly, prompt }),
    );
    await expect(prepareScheduleUpdateApproval(ctx as never, request)).resolves.toBeUndefined();
    // The routine is edited elsewhere while its card waits.
    prompt = "Edited elsewhere";
    const replay = {
      name: "schedule_update",
      args: request.effectRequest,
      finish: async (result: unknown) => result,
    } as never;
    await expect(taskTools.schedule_update!(ctx as never, replay)).resolves.toEqual({
      error: "The schedule changed while saving. Call schedule_list and try again.",
    });
    expect(updateMany).not.toHaveBeenCalled();
  });
});
