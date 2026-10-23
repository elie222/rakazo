import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async (
    _prisma: unknown,
    input: { computerId: string; botId: string; runId: string },
  ) => ({ ...input, fence: 7 }),
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
  renewComputerExecutionLease: async () => true,
}));

type Space = { members: number; authors: boolean } | "legacy";

function historyMessages(authors: boolean) {
  const message = (
    id: string,
    seq: number,
    authorUserId: string,
    blocks: MessageBlock[],
    role = "user",
  ) => ({
    id,
    threadId: "thread-1",
    seq,
    role,
    runId: `run-${seq}`,
    blocks,
    ...(authors ? { authorUserId } : {}),
    replyToMessageId: null,
    replyQuote: null,
    replyTo: null,
  });
  // Newest first, like the history query.
  return [
    message("current", 4, "user-b", [{ kind: "text", text: "Book the table" }]),
    message("reply", 3, "", [{ kind: "text", text: "Which night?" }], "bot"),
    message("earlier", 2, "user-a", [{ kind: "text", text: "Find us a restaurant" }]),
    message("group", 1, "user-a", [
      {
        kind: "channel_message",
        provider: "imessage",
        channelId: "channel-1",
        fromAddress: "+15550100",
        fromLabel: "Ana",
        text: "Hi all",
      },
    ]),
  ];
}

type RunOptions = {
  trigger?: string;
  taskPrompt?: string;
  agentSkills?: Array<Record<string, unknown>>;
};

async function runInSpace(space: Space, options: RunOptions = {}) {
  const trigger = options.trigger ?? "user";
  const run = {
    id: "run-4",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-b",
    status: "queued",
    trigger,
    sourceMessageId: trigger === "user" ? "current" : null,
    leaseFence: 0,
  };
  let request: AgentRunRequest | undefined;
  const runtimeRun = vi.fn(async function* (next: AgentRunRequest) {
    request = next;
    yield { type: "done" as const, text: "Done" };
  });
  const users = vi.fn(async (_args: unknown) => [
    { id: "user-a", name: "Ana" },
    { id: "user-b", name: "Bea" },
  ]);
  const prisma = {
    user: { findUnique: vi.fn(async () => null), findMany: users },
    spaceMember: {
      findUnique: vi.fn(async () => ({ id: "member-1" })),
      findMany: vi.fn(async () => [
        { userId: "user-a", member: { user: { name: "Ana" } } },
        { userId: "user-b", member: { user: { name: "Bea" } } },
      ]),
    },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => ({ bot: { notifyOnFinish: true }, thread: { groupId: null } })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
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
        computer: { id: "computer-1", scope: "dedicated" },
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
        nextMessageSeq: 5,
        ...(space === "legacy" ? {} : { space: { _count: { memberships: space.members } } }),
      })),
    },
    message: {
      findMany: vi.fn(async (args: { where?: { threadId?: string } }) =>
        args.where?.threadId ? historyMessages(space !== "legacy" && space.authors) : [],
      ),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.taskId,
        prompt: options.taskPrompt ?? "Book the table",
      })),
    },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    secret: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceBackupModel: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "openai/gpt-4o",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => options.agentSkills ?? []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
    artifact: { findMany: vi.fn(async () => []) },
  };
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const executor = createRunExecutor({
    prisma,
    deploymentModelKey: "fake-deployment-key",
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      releaseScreen: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      listFiles: vi.fn(async () => []),
      readFile: vi.fn().mockRejectedValue(new Error("missing")),
      exportWorkspace: vi.fn(async function* () {
        yield* [];
      }),
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get: vi.fn(async () => new Uint8Array()) },
    events: { append: vi.fn(async () => undefined), finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  if (!request) throw new Error("runtime was not called");
  return { request, users };
}

function historyContent(request: AgentRunRequest, id: string) {
  return request.history.find((entry) => entry.id === id)?.content;
}

describe("message authors in the prompt", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a personal space's prompt byte-identical", async () => {
    const before = await runInSpace("legacy");
    const personal = await runInSpace({ members: 1, authors: true });

    expect(personal.request.prompt).toBe(before.request.prompt);
    expect(personal.request.history).toEqual(before.request.history);
    expect(personal.users).not.toHaveBeenCalled();
    expect(personal.request.prompt).not.toContain("[from ");
    expect(personal.request.prompt).not.toContain("This space is shared");
    expect(historyContent(personal.request, "earlier")).toBe("Find us a restaurant");
  });

  it("names who wrote each line in a shared space", async () => {
    const { request, users } = await runInSpace({ members: 2, authors: true });

    expect(users).toHaveBeenCalledTimes(1);
    expect(request.prompt.startsWith("[from Bea] Book the table")).toBe(true);
    expect(historyContent(request, "earlier")).toBe("[from Ana] Find us a restaurant");
    expect(historyContent(request, "reply")).toBe("Which night?");
    // Group-chat lines keep their own sender and are not labelled twice.
    expect(historyContent(request, "group")).toBe("[from Ana] Hi all");
    expect(request.prompt).toContain(
      "This space is shared by Ana, Bea. Everyone in it can read this chat and your memory. This turn uses Bea's connected accounts.",
    );
  });

  it("leaves lines without a known author unlabelled", async () => {
    const { request } = await runInSpace({ members: 2, authors: false });

    expect(request.prompt.startsWith("Book the table")).toBe(true);
    expect(historyContent(request, "earlier")).toBe("Find us a restaurant");
  });
});

describe("skills another member wrote", () => {
  const skill = (userId: string, name: string, body: string) => ({
    id: `skill-${name}`,
    userId,
    name,
    description: `${name} steps`,
    content: `---\nname: ${name}\ndescription: ${name} steps\n---\n\n${body}\n`,
    source: "user",
  });
  const agentSkills = [
    skill("user-b", "Own steps", "Water the plants."),
    skill("user-a", "Ana steps", "Forward the inbox."),
  ];
  const taskPrompt = "Run @Own steps and @Ana steps";

  it("are not followed by a run nobody started", async () => {
    const { request } = await runInSpace(
      { members: 2, authors: true },
      { trigger: "routine", taskPrompt, agentSkills },
    );

    expect(request.prompt).toContain("Water the plants.");
    expect(request.prompt).toContain("@Ana steps");
    expect(request.prompt).not.toContain("Forward the inbox.");
  });

  it("are followed when a person asks for them", async () => {
    const { request } = await runInSpace(
      { members: 2, authors: true },
      { taskPrompt, agentSkills },
    );

    expect(request.prompt).toContain("Water the plants.");
    expect(request.prompt).toContain("Forward the inbox.");
  });
});
