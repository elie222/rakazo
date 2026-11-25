import type { AgentHomeStore, ArtifactStore, SandboxProvider } from "@rakazo/adapter-kit";
import { flush } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createSenderQueue } from "../messaging/intake/sender-queue.js";
import type { ArrivalCopyDeps, CopyAttachment } from "./arrival-copy.js";
import { copyOnArrival, createArrivalCopy, startArrivalCopy } from "./arrival-copy.js";

const ids = { botId: "bot-1", userId: "user-1", spaceId: "ws-1" };
const PATH = "attachments/2026-11-17_1912_Dana_photo.jpg";
const bytes = new Uint8Array([1, 2, 3]);

function fakePrisma(computerId: string | null = "computer-1") {
  return {
    bot: { findUnique: vi.fn(async () => ({ computerId })) },
  } as unknown as PrismaClient;
}

function arrivalCopy(overrides: Partial<ArrivalCopyDeps> = {}) {
  const copy = vi.fn<CopyAttachment>(async (input) => ({ copied: `bots/bot-1/${input.path}` }));
  const get = vi.fn(async () => new Uint8Array([4, 5]));
  const deps: ArrivalCopyDeps = {
    prisma: fakePrisma(),
    artifacts: { get } as unknown as ArtifactStore,
    enabled: true,
    copy,
    queue: createSenderQueue(),
    ...overrides,
  };
  return { deps, copy, get };
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

describe("copyOnArrival", () => {
  it("copies each file with a stored path into the bot's computer", async () => {
    const { deps, copy } = arrivalCopy();

    await copyOnArrival(deps, ids, [
      { computerPath: PATH, bytes, storageKey: "key-1" },
      { computerPath: null, bytes, storageKey: "key-2" },
    ]);

    expect(copy).toHaveBeenCalledExactlyOnceWith(
      { bot: { id: "bot-1", computerId: "computer-1" }, path: PATH, bytes },
      expect.objectContaining({ spaceId: "ws-1", userId: "user-1", botId: "bot-1" }),
    );
  });

  it("reads a file's bytes from storage when the caller does not hold them", async () => {
    const { deps, copy, get } = arrivalCopy();

    await copyOnArrival(deps, ids, [{ computerPath: PATH, storageKey: "key-1" }]);

    expect(get).toHaveBeenCalledWith("key-1", expect.objectContaining({ spaceId: "ws-1" }));
    expect(copy).toHaveBeenCalledWith(
      expect.objectContaining({ bytes: new Uint8Array([4, 5]) }),
      expect.anything(),
    );
  });

  it("does nothing for a bot without a computer", async () => {
    const { deps, copy, get } = arrivalCopy({ prisma: fakePrisma(null) });

    await copyOnArrival(deps, ids, [{ computerPath: PATH, storageKey: "key-1" }]);

    expect(get).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });

  it("writes nothing into the computer when the setting is off", async () => {
    const prisma = fakePrisma();
    const writeFile = vi.fn();
    const writeBinaryFile = vi.fn();
    const deps = createArrivalCopy({
      prisma,
      artifacts: {} as ArtifactStore,
      home: { writeBinaryFile } as unknown as AgentHomeStore,
      sandbox: { writeFile } as unknown as SandboxProvider,
      env: { copyAttachmentsOnArrival: false },
    });

    await copyOnArrival(deps, ids, [{ computerPath: PATH, bytes, storageKey: "key-1" }]);

    expect(writeFile).not.toHaveBeenCalled();
    expect(writeBinaryFile).not.toHaveBeenCalled();
    expect(prisma.bot.findUnique).not.toHaveBeenCalled();
  });

  it("moves on to the next copy into a computer once a hung one reaches its deadline", async () => {
    const deadlines = controlledDeadlines();
    const { deps, copy } = arrivalCopy();
    copy
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce({ copied: `bots/bot-1/${PATH}` });
    const file = { computerPath: PATH, bytes, storageKey: "key-1" };

    const hung = copyOnArrival(deps, ids, [file]);
    const next = copyOnArrival(deps, ids, [file]);
    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce());

    deadlines[0]!.abort(new DOMException("timed out", "TimeoutError"));
    await expect(hung).resolves.toBeUndefined();
    await expect(next).resolves.toBeUndefined();
    expect(copy).toHaveBeenCalledTimes(2);
  });

  it("logs a failed copy by its code, never by the path that names the sender and the file", async () => {
    const sink = createTestSink();
    const previous = getLogger();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    onTestFinished(() => installLogger(previous));
    const where = `/data/homes/team-home/bots/bot-1/${PATH}`;
    const failure = Object.assign(new Error(`ENOSPC: no space left on device, open '${where}'`), {
      code: "ENOSPC",
      path: where,
    });
    const { deps, copy } = arrivalCopy();
    copy.mockRejectedValueOnce(failure);

    await expect(
      copyOnArrival(deps, ids, [{ computerPath: PATH, bytes, storageKey: "key-1" }]),
    ).resolves.toBeUndefined();

    const logged = JSON.stringify(sink.events);
    expect(sink.events).toHaveLength(1);
    expect(logged).toContain("ENOSPC");
    expect(logged).not.toContain("Dana");
    expect(logged).not.toContain("photo.jpg");
    expect(logged).not.toContain("/data/homes");
  });
});

describe("startArrivalCopy", () => {
  it("leaves no rejection unhandled when the copy fails before it starts", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    onTestFinished(() => {
      process.off("unhandledRejection", onUnhandled);
    });
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      throw new Error("no timers left");
    });
    onTestFinished(() => timeout.mockRestore());
    const { deps, copy } = arrivalCopy();

    startArrivalCopy(deps, ids, [{ computerPath: PATH, bytes, storageKey: "key-1" }]);
    await flush();
    await flush();

    expect(copy).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });
});
