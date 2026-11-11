import type { ComputerRef } from "@rakazo/adapter-kit";
import { runCodeKind } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeRunCode } from "./bot-secrets.js";
import { builtinAgentTools } from "./builtin-tools.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import type * as RunNotificationsModule from "./run-notifications.js";
import { EncryptedSecretStore } from "./secrets.js";

const COMPUTER: ComputerRef = {
  id: "sandbox-1",
  botId: "home-1",
  kind: "e2b",
  providerRef: "sandbox-1",
};

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  provisionComputer: async () => COMPUTER,
}));

const notified = vi.hoisted(() => [] as unknown[]);
vi.mock("./run-notifications.js", async (importOriginal) => ({
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
function world(printed = "") {
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
    createdAt: new Date(Date.now() - 10 * 60 * 1000),
  };
  const thread = { groupId: null as string | null };
  /** Where the bot's browser is; null when no page was opened this attempt. */
  const page = { url: `${ORIGIN}/verify` as string | null };
  /** Called while the run pauses for a card, before anything looks at the inbox again. */
  const whilePausing: Array<() => void> = [];
  const answered: Row[] = [];
  const calls: unknown[] = [];
  const effects: Row[] = [];
  const secrets: Row[] = [];
  const appended: unknown[] = [];
  const asked: Array<{ blocks: Array<Record<string, unknown>> }> = [];
  /** The bot's inbox, newest first as listed. */
  const emails: Row[] = [];
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
      // The bot looks at its page first, as it does before it asks for that page's code.
      if (page.url) await request.executeTool?.("browser_snapshot", {}, "exec-0");
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
          findFirst: async () => ({ bot: { notifyOnFinish: false }, thread }),
          findMany: async ({ where }: { where: Row }) =>
            matches(run, where)
              ? [
                  {
                    ...run,
                    sourceMessage: null,
                    thread: { groupId: thread.groupId, externalConversationId: null },
                  },
                ]
              : [],
          updateMany: async ({ data }: { data: Row }) => {
            Object.assign(run, data);
            return { count: 1 };
          },
        },
        bot: {
          findUniqueOrThrow: async () => ({
            id: run.botId,
            userId: scope.userId,
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
            groupId: thread.groupId,
            historyCompactionSummary: null,
            historyCompactedUpToSeq: null,
            nextMessageSeq: 1,
          }),
          update: async () => ({ nextMessageSeq: 1, nextEventSeq: 1 }),
        },
        message: {
          create: async ({ data }: { data: object }) => ({ id: "message-1", ...data }),
          // Only the inbox asks for the run's own cards by run id; history sees none.
          findMany: async ({ where }: { where: Row }) =>
            where.runId && where.role === "bot"
              ? asked
                  .map((input, index) => ({ id: `card-${index + 1}`, blocks: input.blocks }))
                  .reverse()
              : [],
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
          create: async ({ data }: { data: Row }) => {
            secrets.push({ ...data });
            return data;
          },
          updateMany: async ({ where, data }: { where: Row; data: Row }) => {
            const rows = secrets.filter((row) => matches(row, where));
            for (const row of rows) Object.assign(row, data);
            return { count: rows.length };
          },
        },
        botEmailAddress: { findUnique: async () => ({ name: "helper" }) },
        botEmailMessage: {
          findFirst: async ({ where }: { where: Row }) =>
            emails.find((email) => email.id === where.id) ?? null,
          findMany: async ({
            where,
            orderBy,
            cursor,
            skip = 0,
            take,
          }: {
            where: Row & {
              receivedAt?: { gte?: Date; gt?: Date; lt?: Date };
              OR?: Array<Record<string, { contains: string }>>;
            };
            orderBy?: unknown;
            cursor?: { id: string };
            skip?: number;
            take?: number;
          }) => {
            const { gte, gt, lt } = where.receivedAt ?? {};
            const found = emails
              .filter((email) => {
                const at = email.receivedAt as Date;
                return (
                  ["botId", "sent", "verified"].every(
                    (key) => where[key] === undefined || email[key] === where[key],
                  ) &&
                  (!gte || at >= gte) &&
                  (!gt || at > gt) &&
                  (!lt || at < lt) &&
                  // As the database does: on the stored text, hidden values and all.
                  (!where.OR ||
                    where.OR.some((match) =>
                      Object.entries(match).every(([field, { contains }]) =>
                        String(email[field]).toLowerCase().includes(contains.toLowerCase()),
                      ),
                    ))
                );
              })
              .sort((a, b) => (b.receivedAt as Date).getTime() - (a.receivedAt as Date).getTime());
            if ((orderBy as { receivedAt?: string } | undefined)?.receivedAt === "asc")
              found.reverse();
            const start = cursor ? found.findIndex((email) => email.id === cursor.id) : 0;
            if (start < 0) return [];
            return found.slice(start + skip, take === undefined ? undefined : start + skip + take);
          },
        },
        deploymentSettings: {
          findUnique: async () => ({
            defaultModelProvider: "local",
            defaultModelId: "local-model",
          }),
        },
        actionAutoReviewPreference: {
          findUnique: async () => ({ enabled: false, skipApprovals: true }),
        },
        userActionAutoReviewPreference: {
          findUnique: async () => ({ enabled: false, skipApprovals: true }),
        },
        externalEffect: {
          findUnique: async ({ where }: { where: Row }) =>
            effects.find((row) => matches(row, where)) ?? null,
          findMany: async ({ where }: { where: Row }) =>
            effects.filter((row) => matches(row, where)),
          findFirst: async ({
            where,
          }: {
            where: Row & { status: string | { not: string }; updatedAt?: { gte: Date } };
          }) => {
            const { status, updatedAt, ...rest } = where;
            if (typeof status === "string")
              return effects.findLast((row) => matches(row, { ...rest, status })) ?? null;
            // The inbox asks this: a secret request of this bot's answered since a time.
            return (
              effects.find(
                (row) =>
                  row.kind === rest.kind &&
                  row.status !== status.not &&
                  (row.updatedAt as Date) >= updatedAt!.gte,
              ) ?? null
            );
          },
          createMany: async ({ data }: { data: Row[] }) => {
            let count = 0;
            for (const row of data) {
              if (effects.some((effect) => effect.idempotencyKey === row.idempotencyKey)) continue;
              effects.push({ id: `effect-${effects.length + 1}`, updatedAt: new Date(), ...row });
              count += 1;
            }
            return { count };
          },
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
            for (const row of rows) Object.assign(row, data, { updatedAt: new Date() });
            return { count: rows.length };
          },
        },
      },
      calls,
    );
    const executor = createRunExecutor({
      prisma,
      deploymentModelKey: "fake-deployment-key",
      inboundEmailDomain: "bots.test",
      browser: {
        describe: () => ({ capabilities: { page: true } }),
        snapshot: async () =>
          page.url
            ? { url: page.url, title: "Verify", tree: 'textbox "Code" [e1]', elements: [] }
            : { error: "No page is open." },
      },
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
          run.status = "waiting_input";
          for (const change of whilePausing.splice(0)) change();
          return true;
        }),
        answerRunInput: vi.fn(async ({ claimEmail, ...input }: Row) => {
          // The email is taken in the answer's own transaction, as the database does it.
          await (prisma.$transaction as (fn: unknown) => Promise<unknown>)(claimEmail);
          answered.push(input);
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

  /** The user answers the open card: the effect is approved and the code waits for the page. */
  async function userAnswers(code = CODE) {
    for (const effect of effects)
      if (effect.status === "intended")
        Object.assign(effect, { status: "approved", updatedAt: new Date() });
    const stored = await secretStore.put(
      encodeRunCode(ORIGIN, code),
      { ...scope, operationId: "run-1", traceId: "run-1", signal: new AbortController().signal },
      { ephemeral: true },
    );
    secrets.push({
      ...stored,
      userId: scope.userId,
      spaceId: scope.spaceId,
      kind: runCodeKind("run-1"),
    });
  }

  const everythingWritten = () => JSON.stringify([calls, appended, asked, effects]);
  /** Mail arrives in the bot's inbox. */
  function receives(email: Partial<Row> & { text: string }) {
    emails.push({
      id: `email-${emails.length + 1}`,
      key: `dkim:signature-${emails.length + 1}`,
      botId: scope.botId,
      fromAddress: "no-reply@example.test",
      fromName: "Example",
      subject: "Your sign-in code",
      verified: true,
      sent: false,
      to: ["helper@bots.test"],
      cc: [],
      attachments: [],
      receivedAt: new Date(Date.now() - 30 * 1000),
      ...email,
    });
  }

  return {
    attempt,
    userAnswers,
    receives,
    run,
    thread,
    page,
    whilePausing,
    answered,
    effects,
    /** The run's secret requests, without the inbox's own records. */
    requests: () => effects.filter((effect) => effect.kind === "request_secret"),
    secrets,
    asked,
    calls,
    everythingWritten,
  };
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
    expect(run.requests()).toMatchObject([
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
    expect(run.requests()).toMatchObject([{ status: "completed" }]);
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
    expect(run.requests()).toHaveLength(2);
    expect(run.requests()[1]).toMatchObject({ status: "intended" });
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
    expect(run.requests()).toHaveLength(1);
  });
});

describe("request_secret for a code the site emailed to the bot", () => {
  const CODE_EMAIL = { text: `Your verification code is ${CODE}. It expires in 10 minutes.` };
  const NEWER_CODE = "731905";
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000);
  const decoded = async (row: Row) =>
    JSON.parse(await secretStore.load(String(row.ciphertext), String(row.id)));

  async function ownerAnsweredResult() {
    const run = world();
    await run.attempt([requestCode()]);
    await run.userAnswers();
    return (await run.attempt([requestCode()]))[0];
  }

  it("takes the one code in the inbox for that site, as the owner's answer would be taken", async () => {
    const expected = await ownerAnsweredResult();
    notified.length = 0;
    const run = world();
    run.receives(CODE_EMAIL);
    const [result] = await run.attempt([requestCode()]);
    // Told where it came from, as the owner's answer is, and never the code.
    expect(result).toEqual({
      ...(expected as object),
      note: "The code from the email the site sent was entered. Type it with browser_act fill_code {ref}; it is not shown to you.",
    });
    // No card, no push for one, no pause: the only notice is that the run finished.
    expect(run.asked).toEqual([]);
    expect(notified).toMatchObject([{ kind: "completion" }]);
    expect(run.run.status).not.toBe("waiting_input");
    // Stored as the card's answer is, sealed under this run's code row.
    expect(run.secrets).toHaveLength(1);
    expect(run.secrets[0]).toMatchObject({
      userId: scope.userId,
      spaceId: scope.spaceId,
      kind: runCodeKind("run-1"),
    });
    expect(String(run.secrets[0]!.ciphertext)).not.toContain(CODE);
    expect(await decoded(run.secrets[0]!)).toEqual({
      origin: ORIGIN,
      code: CODE,
      fromEmail: "email-1",
    });
    expect(run.requests()).toMatchObject([{ kind: "request_secret", status: "completed" }]);
    expect(run.everythingWritten()).not.toContain(CODE);
  });

  it("hides the code from the email when the run reads it afterwards", async () => {
    const run = world();
    run.receives({ ...CODE_EMAIL, subject: `${CODE} is your code` });
    const results = await run.attempt([
      requestCode(),
      { name: "read_email", args: { id: "email-1" } },
      { name: "read_email", args: {} },
    ]);
    expect(results[1]).toMatchObject({ email: { id: "email-1" } });
    expect(results[2]).toMatchObject({ emails: [{ id: "email-1" }] });
    expect(JSON.stringify(results)).not.toContain(CODE);
    expect(run.everythingWritten()).not.toContain(CODE);
  });

  it("keeps hiding it in a later attempt, after the page took it", async () => {
    const run = world();
    run.receives(CODE_EMAIL);
    await run.attempt([requestCode()]);
    run.secrets[0]!.kind = `run-code-spent:run-1`;
    const [read] = await run.attempt([{ name: "read_email", args: { id: "email-1" } }]);
    expect(read).toMatchObject({ email: { id: "email-1" } });
    expect(JSON.stringify(read)).not.toContain(CODE);
  });

  it("takes a dashed code from the site's mail subdomain", async () => {
    const run = world();
    run.receives({ text: "Your code is 731-905.", fromAddress: "auth@mail.example.test" });
    await run.attempt([requestCode()]);
    expect(await decoded(run.secrets[0]!)).toMatchObject({
      code: NEWER_CODE,
      fromEmail: "email-1",
    });
  });

  it("shows the card when two emails from the site hold different codes", async () => {
    const run = world();
    run.receives({ text: "Your code is 112233.", receivedAt: minutesAgo(3) });
    run.receives({ text: "Your code is 731-905." });
    const [result] = await run.attempt([requestCode()]);
    expect(result).toMatchObject({ details: { secret: "paused" } });
    expect(run.secrets).toEqual([]);
  });

  it.each(["4829", "48291"])(
    "opens the card for an emailed %s, too short to hide, and hides nothing of it",
    async (code) => {
      const run = world();
      run.receives({ subject: `${code} is your code`, text: `Your verification code is ${code}.` });
      const [result] = await run.attempt([requestCode()]);
      expect(result).toMatchObject({ details: { secret: "paused" } });
      expect(run.asked).toHaveLength(1);
      expect(run.secrets).toEqual([]);
      // Its email is not claimed.
      expect(run.effects.some((effect) => effect.status === "taken")).toBe(false);
      const [read] = await run.attempt([{ name: "read_email", args: { id: "email-1" } }]);
      expect(read).toMatchObject({ email: { text: `Your verification code is ${code}.` } });
    },
  );

  it.each<[string, string]>([
    ["a no-break space", "482\u00a0913"],
    ["dots", "4.8.2.9.1.3"],
    ["a double space", "482  913"],
    ["digits on separate lines", "4\n8\n2\n9\n1\n3"],
    ["middle dots and dashes", "48·29–13"],
  ])(
    "hides the taken code written with %s in every email read_email returns",
    async (_name, written) => {
      const run = world();
      run.receives({ text: `Your verification code is ${CODE}.\n\nOr type ${written}.` });
      run.receives({
        fromAddress: "friend@elsewhere.test",
        subject: `Fwd: ${written}`,
        text: `Is ${written} yours?`,
      });
      const results = await run.attempt([
        requestCode(),
        { name: "read_email", args: { id: "email-1" } },
        { name: "read_email", args: { id: "email-2" } },
        { name: "read_email", args: {} },
      ]);
      expect(results[0]).toMatchObject({ submitted: true });
      expect(results[2]).toMatchObject({
        email: { subject: "Fwd: [redacted]", text: "Is [redacted] yours?" },
      });
      expect((results[3] as { emails: unknown[] }).emails).toHaveLength(2);
      const read = JSON.stringify(results.slice(1));
      expect(read).not.toContain(JSON.stringify(written).slice(1, -1));
      expect(read).toContain("Or type [redacted].");
    },
  );

  it("hides a written-out code only in email, not in the rest of what the run reads", async () => {
    const run = world("page=4.8.2.9.1.3");
    run.receives(CODE_EMAIL);
    const results = await run.attempt([
      requestCode(),
      { name: "shell", args: { command: "read-page" } },
    ]);
    expect(results[0]).toMatchObject({ submitted: true });
    expect(JSON.stringify(results[1])).toContain("page=4.8.2.9.1.3");
  });

  it.each<[string, string, string]>([
    ["6-digit", CODE, CODE],
    ["8-digit", "48291377", "48291377"],
    ["spaced", CODE, "482 913"],
    ["dashed", CODE, "482-913"],
    ["letter", "K7Q2M9", "K7Q2M9"],
  ])(
    "hides a %s code as the email wrote it, in the email, its preview and subject",
    async (_name, code, written) => {
      const run = world();
      run.receives({
        subject: `${written} is your code`,
        text: `Your verification code is ${written}.`,
      });
      const results = await run.attempt([
        requestCode(),
        { name: "read_email", args: { id: "email-1" } },
        { name: "read_email", args: {} },
      ]);
      expect(results[0]).toMatchObject({ submitted: true });
      expect(await decoded(run.secrets[0]!)).toMatchObject({ code });
      expect(results[1]).toMatchObject({ email: { id: "email-1" } });
      expect(results[2]).toMatchObject({ emails: [{ id: "email-1" }] });
      const read = JSON.stringify(results.slice(1));
      expect(read).not.toContain(written);
      expect(read).not.toContain(code);
    },
  );

  it("never matches a search on the hidden code, only on what the bot may read", async () => {
    const run = world();
    run.receives({ ...CODE_EMAIL, text: "Your verification code is 482 913." });
    const results = await run.attempt([
      requestCode(),
      { name: "read_email", args: { query: "482 9" } },
      { name: "read_email", args: { query: "913" } },
      { name: "read_email", args: { query: "verification" } },
    ]);
    expect(results[0]).toMatchObject({ submitted: true });
    expect(results[1]).toMatchObject({ emails: [] });
    expect(results[2]).toMatchObject({ emails: [] });
    expect(results[3]).toMatchObject({ emails: [{ id: "email-1" }] });
  });

  it("returns the same for a search matching only the hidden code as for one matching nothing", async () => {
    const run = world();
    const since = minutesAgo(5).toISOString();
    run.receives({ text: "Welcome to Example.", receivedAt: minutesAgo(4) });
    run.receives({ ...CODE_EMAIL, receivedAt: minutesAgo(1) });
    const search = (query: string, extra: Record<string, unknown> = {}) => ({
      name: "read_email",
      args: { query, ...extra },
    });
    const results = await run.attempt([
      requestCode(),
      search("482913", { since }),
      search("zzzzqq", { since }),
      search("482913", { since, limit: 1 }),
      search("zzzzqq", { since, limit: 1 }),
      search("482913"),
      search("zzzzqq"),
    ]);
    expect(results[0]).toMatchObject({ submitted: true });
    expect(results[1]).toMatchObject({ emails: [] });
    for (const at of [1, 3, 5])
      expect(JSON.stringify(results[at])).toBe(JSON.stringify(results[at + 1]));
  });

  it.each<[string, string | null]>([
    ["is on another origin of the site", "https://www.example.test/verify"],
    ["is on another site", "https://evil.test/verify"],
    ["has no page open", null],
  ])(
    "shows the card when the run's browser %s, whatever origin the bot names",
    async (_name, url) => {
      const run = world();
      run.page.url = url;
      run.receives(CODE_EMAIL);
      const [result] = await run.attempt([requestCode()]);
      expect(result).toMatchObject({ details: { secret: "paused" } });
      expect(run.secrets).toEqual([]);
      // Nor does mail that comes while the card waits answer it.
      expect(run.effects.some((effect) => effect.kind === "emailed_code")).toBe(false);
    },
  );

  it("answers the card with mail that came while it was being saved", async () => {
    notified.length = 0;
    const run = world();
    run.whilePausing.push(() => run.receives({ ...CODE_EMAIL, receivedAt: new Date() }));
    const [result] = await run.attempt([requestCode()]);
    expect(result).toMatchObject({ details: { secret: "paused" } });
    expect(run.answered).toMatchObject([
      { runId: "run-1", messageId: "card-1", answer: CODE, fromEmail: "email-1" },
    ]);
    // Claimed for this run as any inbox answer is, and nobody is asked for it.
    expect(run.effects).toContainEqual(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^emailed-code:email:bot-1:/),
        request: { emailId: "email-1", site: "example.test" },
        runId: "run-1",
      }),
    );
    expect(notified).not.toContainEqual(expect.objectContaining({ kind: "help" }));
  });

  it("asks the owner when nothing came while the card was being saved", async () => {
    notified.length = 0;
    const run = world();
    await run.attempt([requestCode()]);
    expect(run.answered).toEqual([]);
    expect(notified).toContainEqual(expect.objectContaining({ kind: "help" }));
  });

  it.each<[string, Partial<Row> & { text: string }]>([
    ["holds two codes", { text: `Your code is ${CODE}. The old code 731905 expired.` }],
    ["holds no code", { text: "Click the link to sign in." }],
    ["came from another site", { ...CODE_EMAIL, fromAddress: "no-reply@other.test" }],
    ["came from a look-alike domain", { ...CODE_EMAIL, fromAddress: "x@example.test.evil.test" }],
    ["was not signed by its sender", { ...CODE_EMAIL, verified: false }],
    ["is one the bot sent", { ...CODE_EMAIL, sent: true }],
    ["came well before the request", { ...CODE_EMAIL, receivedAt: minutesAgo(6) }],
  ])("shows the card when the email %s", async (_name, email) => {
    const run = world();
    run.receives(email);
    const [result] = await run.attempt([requestCode()]);
    expect(result).toMatchObject({ details: { secret: "paused" } });
    expect(run.asked).toHaveLength(1);
    expect(run.secrets).toEqual([]);
  });

  it("shows the card for mail that came before the run started", async () => {
    const run = world();
    run.run.createdAt = minutesAgo(1);
    run.receives({ ...CODE_EMAIL, receivedAt: minutesAgo(2) });
    const [result] = await run.attempt([requestCode()]);
    expect(result).toMatchObject({ details: { secret: "paused" } });
  });

  it("does not look in the inbox for a newer email that is not from the site", async () => {
    const run = world();
    run.receives({ ...CODE_EMAIL, receivedAt: minutesAgo(2) });
    run.receives({ text: "Order 48213977 has shipped.", fromAddress: "shop@store.test" });
    await run.attempt([requestCode()]);
    expect(await decoded(run.secrets[0]!)).toMatchObject({ code: CODE });
  });

  it.each<[string, (run: ReturnType<typeof world>) => void]>([
    ["another bot's message", (run) => (run.run.trigger = "bot_message")],
    ["a group", (run) => (run.thread.groupId = "group-1")],
    ["another member", (run) => (run.run.userId = "user-2")],
  ])("shows the card in a run for %s, which may not read the inbox", async (_name, change) => {
    const run = world();
    change(run);
    run.receives(CODE_EMAIL);
    const [result] = await run.attempt([requestCode()]);
    expect(result).toMatchObject({ details: { secret: "paused" } });
    expect(run.asked).toHaveLength(1);
  });

  it("never takes a code from the same email twice", async () => {
    const run = world();
    run.receives(CODE_EMAIL);
    const results = await run.attempt([
      requestCode(),
      // The page took the code and asks for another.
      () => (run.secrets[0]!.kind = "run-code-spent:run-1"),
      requestCode(),
    ]);
    expect(results[0]).toMatchObject({ submitted: true });
    expect(results[1]).toMatchObject({ details: { secret: "paused" } });
    expect(run.asked).toHaveLength(1);
  });

  it("never takes a code from an email that came before another request was answered", async () => {
    const run = world();
    run.receives(CODE_EMAIL);
    // Another of the bot's runs had its code request answered after the email came.
    run.effects.push({
      id: "effect-other",
      runId: "run-0",
      spaceId: scope.spaceId,
      kind: "request_secret",
      status: "completed",
      updatedAt: new Date(),
    });
    const [result] = await run.attempt([requestCode()]);
    expect(result).toMatchObject({ details: { secret: "paused" } });
    expect(run.secrets).toEqual([]);
  });

  it("keeps an unused emailed code hidden, and its email used, when the bot asks again", async () => {
    const run = world();
    run.receives(CODE_EMAIL);
    const results = await run.attempt([requestCode(), requestCode()]);
    expect(results[0]).toMatchObject({ submitted: true });
    expect(results[1]).toMatchObject({ details: { secret: "paused" } });
    expect(run.secrets).toMatchObject([{ kind: "run-code-spent:run-1" }]);
    const [read] = await run.attempt([{ name: "read_email", args: { id: "email-1" } }]);
    expect(JSON.stringify(read)).not.toContain(CODE);
  });

  it("keeps an emailed code it could not read hidden when the bot asks again", async () => {
    const run = world();
    run.receives(CODE_EMAIL);
    const load = vi.spyOn(secretStore, "load").mockRejectedValue(new Error("store unavailable"));
    const [taken, asked] = await run.attempt([requestCode(), requestCode()]);
    expect(taken).toMatchObject({ submitted: true });
    expect(asked).toMatchObject({ details: { secret: "paused" } });
    load.mockRestore();
    expect(run.secrets).toMatchObject([{ kind: "run-code-spent:run-1" }]);
    const [read] = await run.attempt([{ name: "read_email", args: { id: "email-1" } }]);
    expect(read).toMatchObject({ email: { id: "email-1" } });
    expect(JSON.stringify(read)).not.toContain(CODE);
  });

  it("starts no attempt while its emailed code cannot be read, and hides it once it can", async () => {
    const run = world();
    run.receives(CODE_EMAIL);
    await run.attempt([requestCode()]);
    vi.spyOn(secretStore, "load").mockRejectedValueOnce(new Error("store unavailable"));
    // Setup fails and the job retries it, before any tool runs.
    await expect(
      run.attempt([{ name: "read_email", args: { id: "email-1" } }]),
    ).rejects.toMatchObject({ cause: { name: "RunCodeUnreadableError" } });
    const [read] = await run.attempt([{ name: "read_email", args: { id: "email-1" } }]);
    expect(read).toMatchObject({ email: { id: "email-1" } });
    expect(JSON.stringify(read)).not.toContain(CODE);
  });

  it("takes no second emailed code for the same site in a run, and shows the card", async () => {
    const run = world();
    run.receives({ ...CODE_EMAIL, receivedAt: minutesAgo(2) });
    const results = await run.attempt([
      requestCode(),
      () => {
        run.secrets[0]!.kind = "run-code-spent:run-1";
        run.receives({
          text: `Your new code is ${NEWER_CODE}.`,
          receivedAt: new Date(Date.now() + 1000),
        });
      },
      requestCode(),
    ]);
    expect(results[0]).toMatchObject({ submitted: true });
    expect(results[1]).toMatchObject({ details: { secret: "paused" } });
    expect(run.asked).toHaveLength(1);
    expect(run.secrets.find((row) => row.kind === runCodeKind("run-1"))).toBeUndefined();
  });

  it("gives a background helper of the run neither the code's email nor a fill of its own", async () => {
    const run = world();
    run.receives(CODE_EMAIL);
    await run.attempt([requestCode()]);
    expect(run.secrets).toHaveLength(1);
    // The helper the run started: its own run, on its own thread, under the same owner and bot.
    Object.assign(run.run, { id: "run-helper", threadId: "thread-helper", trigger: "helper" });
    const effectsBefore = run.effects.length;
    const results = await run.attempt([
      { name: "read_email", args: { id: "email-1" } },
      { name: "read_email", args: { query: "verification" } },
      requestCode(),
    ]);
    for (const result of results)
      expect(result).toMatchObject({ error: expect.stringContaining("background helper") });
    expect(JSON.stringify(results)).not.toContain(CODE);
    expect(run.everythingWritten()).not.toContain(CODE);
    expect(run.effects).toHaveLength(effectsBefore);
    expect(run.secrets).toHaveLength(1);
  });
});
