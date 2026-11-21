import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { CopyAttachment } from "../attachments/arrival-copy.js";
import { createSenderQueue } from "../messaging/intake/sender-queue.js";
import type { ThreadTarget } from "./thread-target.js";
import { sendThreadMessage } from "./thread-target.js";

const PATH = "attachments/2026-11-18_0930_Dana_report.pdf";

/** A send of one stored file, from the web or mobile composer, with arrival copies on. */
function fixture(group = false) {
  const tx = {
    space: { findUnique: vi.fn(async () => null) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    chatGroup: {
      update: vi.fn(),
      findFirst: vi.fn().mockResolvedValue({
        members: [
          { bot: { id: "bot-1", name: "First", color: "blue" } },
          { bot: { id: "bot-2", name: "Second", color: "blue" } },
        ],
      }),
    },
    thread: {
      update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
        data.nextMessageSeq ? { nextMessageSeq: 1 } : { nextEventSeq: 1 },
      ),
    },
    artifact: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "file-1",
          name: "report.pdf",
          mimeType: "application/pdf",
          size: 4,
          storageKey: "key-1",
          computerPath: PATH,
        },
      ]),
    },
    bot: { findUnique: vi.fn(async () => ({ computerId: "computer-1" })) },
    message: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "message-1", seq: 1 }),
      update: vi.fn(),
    },
    run: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
      create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
    },
    task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
    steeringMessage: { create: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    event: {
      create: vi.fn().mockResolvedValue({ seq: 1 }),
      findFirst: vi.fn().mockResolvedValue({ seq: 1, payload: {} }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
  } as unknown as PrismaClient;
  const get = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
  const copy = vi.fn<CopyAttachment>();
  const send = () =>
    sendThreadMessage(
      {
        prisma,
        sandbox: {} as never,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
        arrivalCopy: {
          prisma,
          artifacts: { get } as unknown as ArtifactStore,
          enabled: true,
          copy,
          queue: createSenderQueue(),
        },
      },
      { userId: "user-1", spaceId: "space-1" } as Actor,
      (group
        ? { kind: "group", groupId: "group-1", threadId: "thread-1" }
        : {
            kind: "bot",
            botId: "bot-1",
            threadId: "thread-1",
            bot: { id: "bot-1", computer: null },
          }) as ThreadTarget,
      {
        text: "Here it is",
        artifactIds: ["file-1"],
        clientNonce: "file-send-1",
        mentions: group ? ["bot-1", "bot-2"] : undefined,
      } as Parameters<typeof sendThreadMessage>[3],
    );
  return { send, copy, get };
}

describe("copying a sent file into the bot's computer", () => {
  it("returns from a send to one bot before a slow copy finishes", async () => {
    const { send, copy, get } = fixture();
    const slow = deferred<{ copied: string }>();
    copy.mockReturnValueOnce(slow.promise);

    await expect(send()).resolves.toMatchObject({ runId: "run-1" });

    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce());
    expect(get).toHaveBeenCalledWith("key-1", expect.objectContaining({ spaceId: "space-1" }));
    expect(copy).toHaveBeenCalledWith(
      {
        bot: { id: "bot-1", computerId: "computer-1" },
        path: PATH,
        bytes: new Uint8Array([1, 2, 3, 4]),
      },
      expect.objectContaining({ spaceId: "space-1", botId: "bot-1" }),
    );
    slow.resolve({ copied: `bots/bot-1/${PATH}` });
  });

  it("copies nothing for a send to a group", async () => {
    const { send, copy, get } = fixture(true);

    await send();
    await flush();

    expect(get).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });
});
