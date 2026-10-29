import type { ComputerRef } from "@rakazo/adapter-kit";
import { encodeLoginSecret } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
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

const USERNAME = "fake-user@example.test";
const PASSWORD = "fake pass!word";
const secretStore = new EncryptedSecretStore("test-only-encryption-key");

type ExecuteTool = (
  name: string,
  args: Record<string, unknown>,
  executionId: string,
) => Promise<unknown>;

/**
 * A later run of a bot whose login an earlier run filled: the run never calls fill_secret, but
 * the page still holds the values, and its tools print them.
 */
async function runAfterFill(
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
  options: { savedLogin?: boolean; reply?: string } = {},
) {
  const run = {
    id: "run-2",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "routine",
    routineId: "routine-1",
    retryOfRunId: null,
    leaseFence: 0,
  };
  const scope = { userId: run.userId, spaceId: run.spaceId, botId: run.botId };
  const loginRow = {
    ...scope,
    name: "site_login",
    origin: "https://login.example.test",
    auth: { type: "login" },
    ...(await secretStore.put(
      encodeLoginSecret({
        fields: [
          { label: "Username", value: USERNAME, hidden: false },
          { label: "Password", value: PASSWORD, hidden: true },
        ],
      }),
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      { recordId: "login-1" },
    )),
  };
  const commandRow = {
    ...scope,
    name: "cli-token",
    origin: "",
    auth: { type: "command" },
    ...(await secretStore.put(
      "fake-cli-token",
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      { recordId: "command-1" },
    )),
  };
  const botSecrets = options.savedLogin === false ? [commandRow] : [loginRow, commandRow];
  const load = vi.spyOn(secretStore, "load");
  const printed = [
    `user=${USERNAME} pass=${PASSWORD}`,
    `form=${new URLSearchParams({ username: USERNAME, password: PASSWORD })}`,
    `base64=${Buffer.from(PASSWORD).toString("base64")}`,
  ].join("\n");
  const toolResults: unknown[] = [];
  const runtimeRun = vi.fn(async function* (request: { executeTool?: ExecuteTool }) {
    for (const [index, call] of toolCalls.entries()) {
      toolResults.push(await request.executeTool?.(call.name, call.args, `exec-${index}`));
    }
    const reply = options.reply ?? "Done.";
    yield { type: "text-delta" as const, text: reply };
    yield { type: "done" as const, text: reply };
  });
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => ({
        bot: { notifyOnFinish: false },
        thread: { groupId: null },
      })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    routine: { findUnique: vi.fn(async () => ({ notify: false, nextRunAt: null })) },
    event: { count: vi.fn(async () => 0) },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
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
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 1,
      })),
    },
    message: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Check the site" })) },
    computer: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => ({
        state: "running",
        restorePending: false,
        screenGeneration: 0,
      })),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        // Sees images, so computer_observe is offered.
        defaultModelId: "openai/gpt-4o",
      })),
    },
    vaultCredential: { findMany: vi.fn(async () => botSecrets) },
    externalEffect: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `effect-${data.idempotencyKey}`,
        ...data,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const sandbox = {
    describe: () => ({ id: "e2b", capabilities: { graphical: true } }),
    execute: vi.fn(async function* () {
      yield { type: "stdout" as const, data: printed };
      yield { type: "exit" as const, code: 0 };
    }),
    readFile: vi.fn(async () => new TextEncoder().encode(printed)),
    listFiles: vi.fn(async () => [
      { path: `notes/${USERNAME}.txt`, kind: "file", size: 1 },
      { path: `notes/${encodeURIComponent(PASSWORD)}.txt`, kind: "file", size: 1 },
    ]),
    observe: vi.fn(async () => ({
      frameId: "frame-1",
      capturedAt: "2026-10-20T00:00:00.000Z",
      width: 1,
      height: 1,
      image: new Uint8Array([0]),
      activeWindow: { id: "window-1", title: `${USERNAME} - ${PASSWORD}` },
    })),
    releaseScreen: vi.fn(async () => undefined),
    async *exportWorkspace() {
      yield* [];
    },
  };
  const events = {
    append: vi.fn(async () => undefined),
    finalizeRun: vi.fn(async () => ({ continuationRunId: null })),
    pauseRunForTakeover: vi.fn(async () => false),
  };
  const executor = createRunExecutor({
    prisma: withEmptyModels(prisma),
    deploymentModelKey: "fake-deployment-key",
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox,
    secretStore,
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get: vi.fn() },
    events,
    jobs: { enqueue: vi.fn(async () => undefined) },
    notifications: { send: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  const loginLoads = load.mock.calls.filter(([, recordId]) => recordId === "login-1").length;
  const published = JSON.stringify([events.append.mock.calls, events.finalizeRun.mock.calls]);
  return { toolResults, loginLoads, published };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("saved logins in a later run", () => {
  it("hides a password filled by an earlier run from shell and file output", async () => {
    const { toolResults, loginLoads } = await runAfterFill([
      { name: "shell", args: { command: "read-filled-fields" } },
      { name: "read_file", args: { path: "page.txt" } },
    ]);
    expect(toolResults).toHaveLength(2);
    for (const result of toolResults) expect(JSON.stringify(result)).toContain("[redacted]");
    const text = JSON.stringify(toolResults);
    for (const value of [
      PASSWORD,
      encodeURIComponent(PASSWORD),
      new URLSearchParams({ v: PASSWORD }).toString().slice(2),
      Buffer.from(PASSWORD).toString("base64"),
    ]) {
      expect(text).not.toContain(JSON.stringify(value).slice(1, -1));
    }
    // Only the run that fills a login hides its username.
    expect(text).toContain(`user=${USERNAME}`);
    // Decrypted once for the run, not once per tool call.
    expect(loginLoads).toBe(1);
  });

  it("hides saved passwords from the run's first tool, whatever it is", async () => {
    const { toolResults, loginLoads } = await runAfterFill([
      { name: "list_files", args: { path: "notes" } },
    ]);
    const text = JSON.stringify(toolResults);
    expect(text).toContain("notes/[redacted].txt");
    expect(text).not.toContain(encodeURIComponent(PASSWORD));
    expect(text).toContain(`notes/${USERNAME}.txt`);
    expect(loginLoads).toBe(1);
  });

  it("hides a password the browser window title echoes", async () => {
    const { toolResults } = await runAfterFill([{ name: "computer_observe", args: {} }]);
    expect(JSON.stringify(toolResults)).toContain(`${USERNAME} - [redacted]`);
  });

  it("hides a saved password the model writes before any tool call", async () => {
    const { published, loginLoads } = await runAfterFill([], {
      reply: `The page still shows ${PASSWORD}.`,
    });
    expect(published).toContain("The page still shows [redacted].");
    expect(published).not.toContain(PASSWORD);
    expect(loginLoads).toBe(1);
  });

  it("decrypts no login for a bot without one", async () => {
    const { toolResults, loginLoads } = await runAfterFill(
      [{ name: "shell", args: { command: "read-filled-fields" } }],
      { savedLogin: false },
    );
    expect(loginLoads).toBe(0);
    expect(JSON.stringify(toolResults)).toContain(USERNAME);
  });
});

/** Models the run reads but these tests do not care about behave as empty tables. */
function withEmptyModels<T extends object>(prisma: T): T {
  const empty = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
  };
  return new Proxy(prisma, {
    get: (target, key) => (key in target ? target[key as keyof T] : empty),
  });
}
