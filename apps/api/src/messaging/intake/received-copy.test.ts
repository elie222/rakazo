import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { SaveReceivedFile } from "./received-copy.js";
import { saveReceivedCopy } from "./received-copy.js";
import { createSenderQueue } from "./sender-queue.js";

const ids = { botId: "bot-1", userId: "user-1", spaceId: "ws-1" };
const event = { provider: "sendblue", handle: "handle-1", from: "+15551111111" };
const file = { name: "photo.jpg", mimeType: "image/jpeg" };
const bytes = new Uint8Array([1, 2, 3]);

function fakePrisma(timezone: string | null = "UTC") {
  return {
    bot: { findUnique: vi.fn(async () => ({ computerId: "computer-1" })) },
    user: { findUnique: vi.fn(async () => ({ timezone })) },
  } as unknown as PrismaClient;
}

/** Each copy's deadline, aborted by the test instead of the clock. */
function controlledDeadlines() {
  const deadlines: AbortController[] = [];
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  onTestFinished(() => timeout.mockRestore());
  return deadlines;
}

describe("saveReceivedCopy", () => {
  it("moves on to the next copy into a computer once a hung one reaches its deadline", async () => {
    const deadlines = controlledDeadlines();
    const saveReceivedFile = vi
      .fn<SaveReceivedFile>()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce({ saved: "shared/received/2026/11/next.jpg" });
    const deps = { prisma: fakePrisma(), saveReceivedFile };
    const copies = { saves: createSenderQueue(), receivedAt: Date.now() };

    const hung = saveReceivedCopy(deps, ids, event, file, bytes, copies);
    const next = saveReceivedCopy(deps, ids, event, file, bytes, copies);
    await vi.waitFor(() => expect(saveReceivedFile).toHaveBeenCalledOnce());

    deadlines[0]!.abort(new DOMException("timed out", "TimeoutError"));
    await expect(hung).resolves.toBeUndefined();
    await expect(next).resolves.toBe("[saved to shared/received/2026/11/next.jpg]");
    expect(saveReceivedFile).toHaveBeenCalledTimes(2);
  });
});
