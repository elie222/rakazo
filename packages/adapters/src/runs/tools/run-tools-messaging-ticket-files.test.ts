import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../assembly/run-context.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import type { ToolCall } from "./run-tool-gate.js";

const mocks = vi.hoisted(() => ({
  readWorkspaceFile: vi.fn(async (..._args: unknown[]) => ({ bytes: new Uint8Array([1]) })),
  saveWorkspaceFile: vi.fn(async (..._args: unknown[]) => ({
    artifactId: "artifact-zip",
    block: {
      kind: "file" as const,
      artifactId: "artifact-zip",
      name: "result.zip",
      mimeType: "application/zip",
      size: 19_000,
    },
  })),
}));

vi.mock("./run-tools-files.js", () => ({
  readWorkspaceFile: mocks.readWorkspaceFile,
  saveWorkspaceFile: mocks.saveWorkspaceFile,
}));

import { messagingTools } from "./run-tools-messaging.js";

/** The fake-prisma delivery stack the real messageBot routing runs against. */
function ticketDeps(options: {
  assigneeBotId: string | null;
  /** A reassignment that commits between the routing read and the delivery transaction. */
  reassignedDuringDelivery?: string | null;
}) {
  let liveAssignee = options.assigneeBotId;
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "row" }]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    space: { findUnique: vi.fn().mockResolvedValue({ deletingAt: null }) },
    run: {
      findFirst: vi.fn().mockResolvedValue({ id: "run-1" }),
      findUnique: vi.fn().mockResolvedValue({ status: "running" }),
      create: vi.fn().mockResolvedValue({ id: "run-2" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    bot: {
      findFirst: vi
        .fn()
        .mockImplementation(async (args: { where?: { id?: string } }) =>
          args?.where?.id
            ? { id: args.where.id, userId: "user-1", thread: { id: "thread-servo" } }
            : { id: "bot-servo" },
        ),
    },
    user: { findUnique: vi.fn().mockResolvedValue({ labs: ["board"] }) },
    task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
    message: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "message-1", seq: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    event: { create: vi.fn().mockResolvedValue({ seq: 7 }) },
    thread: { update: vi.fn().mockResolvedValue({}) },
    ticketComment: { create: vi.fn().mockResolvedValue({ id: "comment-1" }) },
    ticket: {
      findFirst: vi.fn().mockImplementation(async () => {
        if (options.reassignedDuringDelivery !== undefined)
          liveAssignee = options.reassignedDuringDelivery;
        return {
          id: "ticket-7",
          assigneeBotId: liveAssignee,
          status: "doing",
          number: 7,
          board: { ticketPrefix: "OPS" },
        };
      }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    bot: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "bot-servo",
          name: "Servo",
          computerId: "computer-servo",
          computerSwitching: false,
          thread: { id: "thread-servo" },
        },
      ]),
    },
    message: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    task: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ prompt: "Work on ticket OPS-7. Read it with ticket_get." }),
    },
    board: { findUnique: vi.fn().mockResolvedValue({ id: "board-1", ticketPrefix: "OPS" }) },
    ticket: {
      findFirst: vi
        .fn()
        .mockImplementation(async () => ({ id: "ticket-7", assigneeBotId: liveAssignee })),
    },
    $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaClient;
  return {
    deps: {
      prisma,
      events: { notify: vi.fn().mockResolvedValue(undefined) },
      jobs: { enqueue: vi.fn().mockResolvedValue(undefined) },
      onTicketChange: vi.fn().mockResolvedValue(undefined),
    } as unknown as Pick<ExecutorDeps, "prisma" | "events" | "jobs" | "onTicketChange">,
    tx,
  };
}

function call(args: Record<string, unknown>) {
  return {
    name: "message_bot",
    args: { bot_id: "bot-servo", message: "the export finished", ...args },
    executionId: "exec-1",
    effectKey: "effect-1",
    finish: async (result: unknown) => result,
  } as unknown as ToolCall;
}

/** A ticket-triggered run on its own computer, messaging a bot on another computer. */
function context(deps: unknown) {
  return {
    deps,
    run: {
      id: "run-1",
      spaceId: "space-1",
      userId: "user-1",
      threadId: "thread-coder",
      botId: "bot-coder",
      trigger: "tickets",
      taskId: "task-1",
      sourceMessageId: null,
    },
    bot: { id: "bot-coder", name: "Coder", computerId: "computer-team", computerSwitching: false },
    thread: { id: "thread-coder", groupId: null },
    computer: { mode: "team", get: vi.fn(async () => ({ id: "computer-team" })) },
    context: {},
    secrets: [],
    state: {},
  } as unknown as RunContext;
}

describe("message_bot ticket sends with files", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses copied attachments a ticket result would strand, before saving them", async () => {
    // Two distinct computers, so the files would be saved as copies for Servo —
    // but Servo is the assignee, so the result lands on the ticket as a comment,
    // which cannot carry them. The send is refused before any file is read.
    const harness = ticketDeps({ assigneeBotId: "bot-servo" });
    const result = await messagingTools.message_bot!(
      context(harness.deps),
      call({ files: ["result.zip"], intent: "result" }),
    );

    expect(result).toMatchObject({ error: expect.stringContaining("ticket OPS-7") });
    expect(mocks.readWorkspaceFile).not.toHaveBeenCalled();
    expect(mocks.saveWorkspaceFile).not.toHaveBeenCalled();
    expect(harness.tx.ticketComment.create).not.toHaveBeenCalled();
    expect(harness.tx.task.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.tx.message.create).not.toHaveBeenCalled();
  });

  it("delivers copied attachments to a requester who is not the assignee", async () => {
    const harness = ticketDeps({ assigneeBotId: "bot-other" });
    const result = await messagingTools.message_bot!(
      context(harness.deps),
      call({ files: ["result.zip"], intent: "result" }),
    );

    expect(result).toMatchObject({ ok: true });
    expect(mocks.saveWorkspaceFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "result.zip",
      expect.any(Uint8Array),
      { botId: "bot-servo" },
    );
    const inbound = harness.tx.message.create.mock.calls
      .map(([created]) => created.data)
      .find((data) => data.threadId === "thread-servo");
    expect(inbound?.blocks).toEqual([
      expect.objectContaining({ kind: "bot_message_received", ticketRef: "OPS-7" }),
      expect.objectContaining({ kind: "file", artifactId: "artifact-zip" }),
    ]);
    expect(harness.tx.ticketComment.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trigger: "bot_message", botId: "bot-servo" }),
      }),
    );
  });

  it("keeps a prepared attachment send delivering when the ticket is reassigned to its recipient", async () => {
    // The routing read sees another bot's ticket, so the copies are saved for the
    // chat route; the reassignment lands before the delivery transaction. The
    // send must not switch to the text-only ticket path and strand the copies.
    const harness = ticketDeps({
      assigneeBotId: "bot-other",
      reassignedDuringDelivery: "bot-servo",
    });
    const result = await messagingTools.message_bot!(
      context(harness.deps),
      call({ files: ["result.zip"], intent: "result" }),
    );

    expect(result).toMatchObject({ ok: true });
    expect(mocks.saveWorkspaceFile).toHaveBeenCalledTimes(1);
    const inbound = harness.tx.message.create.mock.calls
      .map(([created]) => created.data)
      .find((data) => data.threadId === "thread-servo");
    expect(inbound?.blocks).toEqual([
      expect.objectContaining({ kind: "bot_message_received", ticketRef: "OPS-7" }),
      expect.objectContaining({ kind: "file", artifactId: "artifact-zip" }),
    ]);
    expect(harness.tx.ticketComment.create).toHaveBeenCalledTimes(1);
    expect(
      harness.tx.run.create.mock.calls.some(([created]) => created.data.trigger === "tickets"),
    ).toBe(false);
  });
});
