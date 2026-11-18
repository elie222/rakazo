import type { PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
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
  it.each([
    ["the account's zone", "Asia/Jerusalem", "Asia/Jerusalem"],
    ["UTC when the account has none", null, "UTC"],
    ["UTC when the account's zone is not a real one", "Mars/Olympus_Mons", "UTC"],
  ])("names the copy in %s", async (_label, timezone, expected) => {
    const saveReceivedFile = vi.fn<SaveReceivedFile>(async () => ({ saved: "x.jpg" }));
    const deps = { prisma: fakePrisma(timezone), saveReceivedFile };

    await saveReceivedCopy(deps, ids, event, file, bytes, {
      saves: createSenderQueue(),
      receivedAt: Date.now(),
    });

    expect(saveReceivedFile).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: expected }),
      expect.anything(),
    );
  });

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

  it("logs a failed copy by its code, never by the path that names the sender and the file", async () => {
    const sink = createTestSink();
    const previous = getLogger();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    onTestFinished(() => installLogger(previous));
    const where =
      "/data/homes/team-home/shared/received/2026/11/2026-11-17_1912_+15551111111_photo.jpg";
    const failure = Object.assign(new Error(`ENOSPC: no space left on device, open '${where}'`), {
      code: "ENOSPC",
      path: where,
    });
    const saveReceivedFile = vi.fn<SaveReceivedFile>(async () => {
      throw failure;
    });

    await expect(
      saveReceivedCopy({ prisma: fakePrisma(), saveReceivedFile }, ids, event, file, bytes, {
        saves: createSenderQueue(),
        receivedAt: Date.now(),
      }),
    ).resolves.toBeUndefined();

    const logged = JSON.stringify(sink.events);
    expect(sink.events).toHaveLength(1);
    expect(logged).toContain("ENOSPC");
    expect(logged).not.toContain("+15551111111");
    expect(logged).not.toContain("photo.jpg");
    expect(logged).not.toContain("/data/homes");
  });
});
