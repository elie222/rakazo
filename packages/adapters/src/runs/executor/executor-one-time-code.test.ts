import type { ComputerRef } from "@rakazo/adapter-kit";
import { answeredRunSecretResult, runCodeKind, runSecretKind } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "../../computers/computer-lifecycle.js";
import { encodeRunCode } from "../../secrets/bot-secrets.js";
import { EncryptedSecretStore } from "../../secrets/secrets.js";
import { builtinAgentTools } from "../../tools/builtin.tool-definition.js";
import type * as RunNotificationsModule from "../lifecycle/run-notifications.js";
import { createRunExecutor } from "./executor.js";

const COMPUTER: ComputerRef = {
  id: "sandbox-1",
  botId: "home-1",
  kind: "e2b",
  providerRef: "sandbox-1",
};

vi.mock("../../computers/computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  waitForRunComputerLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  provisionComputer: async () => COMPUTER,
}));

const notified = vi.hoisted(() => [] as unknown[]);
vi.mock("../lifecycle/run-notifications.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RunNotificationsModule>()),
  notifyRun: async (_deps: unknown, _run: unknown, message: unknown) => {
    notified.push(message);
  },
}));

type Row = Record<string, unknown>;
type ExecuteTool = (
  name: string,
  args: Record<string, unknown>,
  executionId: string,
) => Promise<unknown>;

const ORIGIN = "https://login.example.test";
const CODE = "482913";
const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const scope = { userId: "user-1", spaceId: "space-1", botId: "bot-1" };
const CONNECTION = {
  id: "connection-1",
  spaceId: scope.spaceId,
  userId: scope.userId,
  status: "pending",
  connectorId: "connector-1",
  provider: "provider-1",
};
const ASK_FIRST = [{ effect: "require_approval", matchKind: "tool", matchValue: "request_secret" }];
const requestCode = (extra: Record<string, unknown> = {}) => ({
  name: "request_secret",
  args: { label: "Code", purpose: "otp", oneTimeCode: { origin: ORIGIN }, ...extra },
});

function recordingPrisma(models: Record<string, Record<string, unknown>>, calls: unknown[]) {
  const fallback: Record<string, (...args: unknown[]) => unknown> = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
  };
  const prisma: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_target, model: string) => {
        if (model === "$transaction") {
          return async (fn: (tx: unknown) => unknown) => fn(prisma);
        }
        if (model === "$queryRaw") return async () => [{ locked: 1 }];
        const methods =
          models[model] ??
          (model === "spaceMember" ? { findUnique: () => ({ id: "member-1" }) } : {});
        return new Proxy(methods, {
          get: (target, method: string) => {
            const impl = (target[method] ?? fallback[method]) as
              | ((...args: unknown[]) => unknown)
              | undefined;
            return async (...args: unknown[]) => {
              calls.push([model, method, args]);
              return impl ? impl(...args) : null;
            };
          },
        });
      },
    },
  );
  return prisma;
}

/**
 * One run whose database outlives several attempts, as it does across the pauses of a real run.
 * Each `attempt` is a fresh executor working through some tool calls; what the user does between
 * attempts (answering a card, the page taking a code) is the test's doing.
 */
function world(printed = "", rules: Row[] = [], connection: Row = CONNECTION) {
  const run = {
    id: "run-1",
    botId: scope.botId,
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: scope.spaceId,
    userId: scope.userId,
    status: "queued",
    trigger: "message",
    routineId: null,
    retryOfRunId: null,
    leaseFence: 0,
  };
  const calls: unknown[] = [];
  const effects: Row[] = [];
  const secrets: Row[] = [];
  const appended: unknown[] = [];
  const asked: Array<{ blocks: Array<Record<string, unknown>> }> = [];
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === "object" && "in" in value
        ? (value.in as unknown[]).includes(row[key])
        : value && typeof value === "object" && "startsWith" in value
          ? String(row[key]).startsWith(String(value.startsWith))
          : row[key] === value,
    );

  async function attempt(
    steps: Array<{ name: string; args: Record<string, unknown> } | (() => void)>,
  ) {
    const results: unknown[] = [];
    const runtimeRun = vi.fn(async function* (request: { executeTool?: ExecuteTool }) {
      let at = 0;
      for (const step of steps) {
        if (typeof step === "function") {
          step();
          continue;
        }
        results.push(
          await request
            .executeTool?.(step.name, step.args, `exec-${++at}`)
            .catch((error: unknown) => ({ thrown: (error as Error).message })),
        );
      }
      yield { type: "done" as const, text: "" };
    });
    const prisma = recordingPrisma(
      {
        run: {
          findUnique: async () => run,
          findUniqueOrThrow: async () => run,
          findFirst: async () => ({ bot: { notifyOnFinish: false }, thread: { groupId: null } }),
          updateMany: async ({ data }: { data: Row }) => {
            Object.assign(run, data);
            return { count: 1 };
          },
        },
        bot: {
          findUniqueOrThrow: async () => ({
            id: run.botId,
            name: "Assistant",
            title: "Assistant",
            description: "Test assistant",
            modelProvider: null,
            modelId: null,
            thinkingLevel: null,
            computerId: "computer-1",
            computerSwitching: false,
            memoryScope: null,
            computer: { id: "computer-1", scope: "dedicated", kind: "e2b", homeKey: "home-1" },
          }),
          findMany: async () => [],
        },
        attempt: {
          create: async () => ({ id: "attempt-1" }),
          updateMany: async () => ({ count: 1 }),
        },
        thread: {
          findUniqueOrThrow: async () => ({
            id: run.threadId,
            groupId: null,
            historyCompactionSummary: null,
            historyCompactedUpToSeq: null,
            nextMessageSeq: 1,
          }),
          update: async () => ({ nextMessageSeq: 1, nextEventSeq: 1 }),
        },
        message: { create: async ({ data }: { data: object }) => ({ id: "message-1", ...data }) },
        userActionApprovalRule: { findMany: async () => rules },
        connection: {
          findFirst: async ({ where }: { where: Row }) =>
            matches(connection, where) ? connection : null,
        },
        event: { create: async ({ data }: { data: object }) => ({ seq: 1, ...data }) },
        task: { findUniqueOrThrow: async () => ({ id: run.taskId, prompt: "Sign in" }) },
        secret: {
          findFirst: async ({ where }: { where: Row }) =>
            secrets.find((row) => matches(row, where)) ?? null,
          findMany: async ({ where }: { where: Row }) =>
            secrets.filter((row) => matches(row, where)),
          count: async ({ where }: { where: Row }) =>
            secrets.filter((row) => matches(row, where)).length,
          deleteMany: async ({ where }: { where: Row }) => {
            const kept = secrets.filter((row) => !matches(row, where));
            const count = secrets.length - kept.length;
            secrets.splice(0, secrets.length, ...kept);
            return { count };
          },
        },
        deploymentSettings: {
          findUnique: async () => ({
            defaultModelProvider: "local",
            defaultModelId: "local-model",
          }),
        },
        // Never ask, unless the test saves rules: those only apply in Ask.
        actionAutoReviewPreference: {
          findUnique: async () => ({ enabled: false, skipApprovals: rules.length === 0 }),
        },
        userActionAutoReviewPreference: {
          findUnique: async () => ({ enabled: false, skipApprovals: rules.length === 0 }),
        },
        externalEffect: {
          findUnique: async ({ where }: { where: Row }) =>
            effects.find((row) => matches(row, where)) ?? null,
          findMany: async ({ where }: { where: Row }) =>
            effects.filter((row) => matches(row, where)),
          create: async ({ data }: { data: Row }) => {
            const row = {
              id: `effect-${effects.length + 1}`,
              createdAt: new Date(),
              updatedAt: new Date(),
              ...data,
            };
            effects.push(row);
            return row;
          },
          updateMany: async ({ where, data }: { where: Row; data: Row }) => {
            const rows = effects.filter((row) => matches(row, where));
            for (const row of rows) Object.assign(row, data);
            return { count: rows.length };
          },
        },
      },
      calls,
    );
    const executor = createRunExecutor({
      prisma,
      deploymentModelKey: "fake-deployment-key",
      runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
      sandbox: {
        describe: () => ({ id: "e2b", capabilities: { graphical: true } }),
        releaseScreen: vi.fn(async () => undefined),
        execute: vi.fn(async function* () {
          if (printed) yield { type: "stdout" as const, data: printed };
          yield { type: "exit" as const, code: 0 };
        }),
        async *exportWorkspace() {
          yield* [];
        },
      },
      secretStore,
      home: { commit: vi.fn(async () => "fixture-revision") },
      memory: { read: async () => ({ documents: [] }) },
      memoryProviders: { resolve: async () => null },
      artifacts: { get: vi.fn() },
      events: {
        append: vi.fn(async (event: unknown) => {
          appended.push(event);
        }),
        finalizeRun: vi.fn(async () => ({ continuationRunId: null })),
        pauseRunForTakeover: vi.fn(async () => false),
        pauseRunForInput: vi.fn(async (input: { blocks: Array<Record<string, unknown>> }) => {
          asked.push(input);
          return true;
        }),
        notify: vi.fn(async () => undefined),
      },
      jobs: { enqueue: vi.fn(async () => undefined) },
      notifications: { send: vi.fn(async () => undefined) },
      secrets: [],
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    run.status = "queued";
    await executor.continueRun(run.id, "worker-1");
    return results;
  }

  /**
   * The user answers the open card: the effect is approved, recording the value it holds, and the
   * code waits for the page. `previousRelease` approves as the release before did, recording none.
   */
  async function userAnswers(code = CODE, { connection = false, previousRelease = false } = {}) {
    const stored = await secretStore.put(
      connection ? code : encodeRunCode(ORIGIN, code),
      { ...scope, operationId: "run-1", traceId: "run-1", signal: new AbortController().signal },
      { ephemeral: true },
    );
    for (const effect of effects) {
      if (effect.status !== "intended") continue;
      effect.status = "approved";
      if (!previousRelease) effect.result = answeredRunSecretResult(stored.id);
    }
    secrets.push({
      ...stored,
      createdAt: new Date(),
      userId: scope.userId,
      spaceId: scope.spaceId,
      kind: connection ? runSecretKind("run-1") : runCodeKind("run-1"),
    });
  }

  /** The user allows the action card: the effect is approved, with nothing entered yet. */
  function userAllows() {
    for (const effect of effects) if (effect.status === "intended") effect.status = "approved";
  }

  const everythingWritten = () => JSON.stringify([calls, appended, asked, effects]);
  return { attempt, userAnswers, userAllows, effects, secrets, asked, calls, everythingWritten };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request_secret for a one-time code", () => {
  it("tells the bot to ask for a code with a card, not to take over the screen", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "request_secret")!;
    expect(tool.description).toContain("oneTimeCode");
    expect(tool.description).toContain("fill_code");
    expect(tool.description).not.toMatch(/texted or emailed code[^.]*request_takeover/);
    const takeover = builtinAgentTools.find((entry) => entry.name === "request_takeover")!;
    expect(takeover.description).not.toContain("2FA");
  });

  it("shows a code card for the page's site, with no credential to save", async () => {
    const run = world();
    const [result] = await run.attempt([requestCode({ label: "Verification code" })]);
    expect(result).toMatchObject({ details: { secret: "paused" } });
    expect(run.asked).toHaveLength(1);
    const [block] = run.asked[0]!.blocks;
    expect(block).toEqual({
      kind: "ask",
      // The site is the server's words; the bot's label is only detail beneath it.
      text: "Code for login.example.test",
      detail: "Verification code",
      input: "secret",
      oneTimeCode: { origin: ORIGIN },
      purpose: "otp",
      status: "pending",
    });
    // What is recorded for the request is the site and nothing a code could be in.
    expect(run.effects).toMatchObject([
      { kind: "request_secret", request: { oneTimeCode: { origin: ORIGIN } } },
    ]);
  });

  it("shows the code card whatever purpose the bot names", async () => {
    const run = world();
    await run.attempt([requestCode({ purpose: "api_key" })]);
    expect(run.asked[0]!.blocks[0]).toMatchObject({ purpose: "otp" });
  });

  it.each([
    ["an HTTP page", { origin: "http://login.example.test" }],
    ["a LAN address", { origin: "http://192.168.1.20" }],
  ])("refuses %s, with no card, and tells the bot to explain why", async (_name, oneTimeCode) => {
    const run = world();
    const [result] = await run.attempt([requestCode({ oneTimeCode })]);
    expect(result).toMatchObject({
      error: expect.stringContaining("Ask the user to take over and tell them that is why"),
    });
    expect(run.asked).toEqual([]);
  });

  it("refuses a page with no origin, with no card", async () => {
    const run = world();
    const [result] = await run.attempt([requestCode({ oneTimeCode: {} })]);
    expect(result).toMatchObject({ error: expect.stringContaining("oneTimeCode") });
    expect(run.asked).toEqual([]);
  });

  it("tells the bot to ask again when the answered code cannot be read, then shows a new card", async () => {
    const run = world();
    await run.attempt([requestCode()]);
    await run.userAnswers();
    run.secrets[0]!.ciphertext = "not-a-ciphertext";
    const results = await run.attempt([requestCode(), requestCode()]);
    expect(results[0]).toMatchObject({ error: expect.stringContaining("could not be read") });
    expect(results[1]).toMatchObject({ details: { secret: "paused" } });
    expect(run.secrets).toEqual([]);
    expect(run.asked).toHaveLength(2);
  });

  it("names the site in the push and keeps the bot's label out of it", async () => {
    notified.length = 0;
    const run = world();
    await run.attempt([requestCode({ label: "Your bank needs a code from evil.example" })]);
    const [message] = notified as Array<{ body: string }>;
    expect(message?.body).toContain("login.example.test");
    expect(message?.body).not.toContain("evil.example");
  });

  it("tells the bot the user entered the code, never the code, and leaves it for the page", async () => {
    const run = world();
    await run.attempt([requestCode()]);
    await run.userAnswers();
    const [result] = await run.attempt([requestCode()]);
    expect(result).toEqual({
      ok: true,
      submitted: true,
      note: expect.stringContaining("fill_code"),
    });
    expect(run.everythingWritten()).not.toContain(CODE);
    expect(JSON.stringify(result)).not.toContain(CODE);
    // fill_code is what takes it, once the page has it.
    expect(run.secrets).toHaveLength(1);
    expect(run.effects).toMatchObject([{ status: "completed" }]);
  });

  it("shows a new card for a second identical request in the same run", async () => {
    const run = world();
    await run.attempt([requestCode()]);
    await run.userAnswers();
    const results = await run.attempt([
      requestCode(),
      // The page took the first code (fill_code deletes it) and wants another.
      () => run.secrets.splice(0),
      requestCode(),
    ]);
    expect(results[0]).toMatchObject({ submitted: true });
    expect(results[1]).toMatchObject({ details: { secret: "paused" } });
    expect(run.asked).toHaveLength(2);
    expect(run.effects).toHaveLength(2);
    expect(run.effects[1]).toMatchObject({ status: "intended" });
  });

  it("asks again, and drops the old code, when a new request comes before the page took it", async () => {
    const run = world();
    await run.attempt([requestCode()]);
    await run.userAnswers();
    const results = await run.attempt([requestCode(), requestCode()]);
    expect(results[0]).toMatchObject({ submitted: true });
    expect(results[1]).toMatchObject({ details: { secret: "paused" } });
    expect(run.secrets).toEqual([]);
    expect(run.asked).toHaveLength(2);
  });

  it("never hands a waiting code to a request for another site", async () => {
    const run = world();
    await run.attempt([requestCode()]);
    await run.userAnswers();
    const results = await run.attempt([
      requestCode(),
      requestCode({ oneTimeCode: { origin: "https://other.example.test" } }),
    ]);
    expect(results[0]).toMatchObject({ submitted: true });
    expect(results[1]).toMatchObject({ details: { secret: "paused" } });
    expect(run.secrets).toEqual([]);
    expect(run.asked).toHaveLength(2);
  });

  it.each(["run-code", "run-code-spent"])(
    "keeps hiding a code from what a later attempt reads, while it is %s",
    async (kind) => {
      const run = world("field=482913 slots=4 8 2 9 1 3\nother=kept");
      await run.userAnswers();
      run.secrets[0]!.kind = `${kind}:run-1`;
      const [result] = await run.attempt([{ name: "shell", args: { command: "read-page" } }]);
      const text = JSON.stringify(result);
      expect(text).not.toContain("482913");
      expect(text).not.toContain("4 8 2 9 1 3");
      expect(text).toContain("other=kept");
    },
  );

  it("does not ask twice for the same card when the attempt is retried", async () => {
    const run = world();
    await run.attempt([requestCode()]);
    await run.attempt([requestCode()]);
    expect(run.effects).toHaveLength(1);
  });
});

describe("request_secret behind an action card", () => {
  it.each([
    ["a code", requestCode()],
    [
      "a connection code",
      { name: "request_secret", args: { label: "Code", connectionId: CONNECTION.id } },
    ],
  ])("shows the card for %s once the action is allowed", async (_name, call) => {
    const run = world("", ASK_FIRST);
    await run.attempt([call]);
    expect(run.asked[0]!.blocks[0]).toMatchObject({ approvalEffectId: run.effects[0]!.id });
    run.userAllows();
    const [result] = await run.attempt([call]);
    expect(result).toMatchObject({ details: { secret: "paused" } });
    expect(run.asked[1]!.blocks[0]).toMatchObject({ input: "secret", status: "pending" });
    // Answering the card approves only a request still waiting for it.
    expect(run.effects).toMatchObject([{ status: "intended" }]);
  });

  it("finishes a connection that completed meanwhile, with no card", async () => {
    const call = { name: "request_secret", args: { label: "Code", connectionId: CONNECTION.id } };
    const run = world("", ASK_FIRST, { ...CONNECTION, status: "connected" });
    await run.attempt([call]);
    run.userAllows();
    const [result] = await run.attempt([call]);
    expect(result).toEqual({ ok: true, submitted: true, connected: true });
    expect(run.asked).toHaveLength(1);
    expect(run.effects).toMatchObject([{ status: "completed" }]);
  });

  it("shows a new code card, not a code an earlier card left, once the action is allowed", async () => {
    const run = world("", ASK_FIRST);
    await run.userAnswers();
    run.secrets[0]!.createdAt = new Date(Date.now() - 60_000);
    await run.attempt([requestCode()]);
    run.userAllows();
    const [result] = await run.attempt([requestCode()]);
    expect(result).toMatchObject({ details: { secret: "paused" } });
    expect(run.asked[1]!.blocks[0]).toMatchObject({ oneTimeCode: { origin: ORIGIN } });
    expect(run.secrets).toEqual([]);
  });

  it.each([
    ["a code", requestCode(), {}],
    [
      "a connection code",
      { name: "request_secret", args: { label: "Code", connectionId: CONNECTION.id } },
      { connection: true },
    ],
  ])("takes %s answered in the millisecond the request was made", async (_name, call, kind) => {
    const run = world("", ASK_FIRST);
    await run.attempt([call]);
    run.userAllows();
    await run.attempt([call]);
    await run.userAnswers(CODE, kind);
    run.secrets[0]!.createdAt = run.effects[0]!.createdAt;
    const [result] = await run.attempt([call]);
    expect(result).toMatchObject({ ok: true, submitted: true });
    expect(run.asked).toHaveLength(2);
    expect(run.effects).toMatchObject([{ status: "completed" }]);
  });

  it("never takes a connection code an earlier card left once the request waits again", async () => {
    const call = { name: "request_secret", args: { label: "Code", connectionId: CONNECTION.id } };
    const run = world("", ASK_FIRST);
    await run.attempt([call]);
    run.userAllows();
    // A value no card answered for this request is still held, and the request waits again, as
    // if an attempt stopped between handing back the claim and dropping that value.
    await run.userAnswers(CODE, { connection: true });
    run.effects[0]!.status = "intended";
    const [result] = await run.attempt([call]);
    expect(result).toMatchObject({ details: { secret: "paused" } });
    expect(run.asked[1]!.blocks[0]).toMatchObject({ input: "secret", status: "pending" });
    expect(run.secrets).toEqual([]);
    expect(run.effects).toMatchObject([{ status: "intended" }]);
  });

  it("takes a connection code answered by the previous release", async () => {
    const call = { name: "request_secret", args: { label: "Code", connectionId: CONNECTION.id } };
    const run = world("", ASK_FIRST);
    await run.attempt([call]);
    run.userAllows();
    await run.attempt([call]);
    await run.userAnswers(CODE, { connection: true, previousRelease: true });
    const [result] = await run.attempt([call]);
    expect(result).toMatchObject({ ok: true, submitted: true });
    expect(run.asked).toHaveLength(2);
  });

  it("hands the code answered on its card to the bot", async () => {
    const run = world("", ASK_FIRST);
    await run.attempt([requestCode()]);
    run.userAllows();
    await run.attempt([requestCode()]);
    await run.userAnswers();
    const [result] = await run.attempt([requestCode()]);
    expect(result).toEqual({
      ok: true,
      submitted: true,
      note: expect.stringContaining("fill_code"),
    });
    expect(run.effects).toMatchObject([{ status: "completed" }]);
  });
});
