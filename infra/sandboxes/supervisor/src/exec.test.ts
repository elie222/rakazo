import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Duplex, PassThrough, Readable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core/node/secrets-guard";
import { deferred, flush } from "@rakazo/core/test-async";
import type Docker from "dockerode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readContainerFile, runContainerCommand, writeContainerFile } from "./exec.js";
import { createDockerStreamDemuxer } from "./supervisor-logic.js";

const mock = vi.hoisted(() => ({
  exec: vi.fn(),
  inspect: vi.fn(),
  onNextClose: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const hook = mock.onNextClose;
      if (!hook) return handle;
      mock.onNextClose = undefined;
      const origClose = handle.close.bind(handle);
      handle.close = async () => {
        await hook();
        return origClose();
      };
      return handle;
    },
  };
});
vi.mock("dockerode", () => ({
  default: class {
    getContainer() {
      return mock;
    }
  },
}));

import { supervisorApp } from "./index.js";

function frame(type: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe("runContainerCommand", () => {
  it("streams output without buffering the full result and emits timeout note via onOutput", async () => {
    const start = vi.fn(async () => Readable.from([frame(1, "hello\n"), frame(2, "partial")]));
    const inspect = vi.fn(async () => ({ ExitCode: 124 }));
    const execCalls: Array<Record<string, unknown>> = [];
    const container = {
      exec: vi.fn(async (opts: Record<string, unknown>) => {
        execCalls.push(opts);
        // Second exec is consumeCompletionMarker; exit 1 means the command genuinely timed out.
        if (execCalls.length > 1) {
          return {
            start: async () => Readable.from([]),
            inspect: async () => ({ ExitCode: 1 }),
          };
        }
        return { start, inspect };
      }),
    } as unknown as Docker.Container;

    const controller = new AbortController();
    const pieces: Array<{ stream: "stdout" | "stderr"; data: string }> = [];
    const result = await runContainerCommand(container, ["echo", "hi"], {
      timeoutMs: 5_000,
      signal: controller.signal,
      onOutput: (chunk) => pieces.push(chunk),
    });

    // Passing a cancellation signal without stdin must not attach stdin (shell commands expect EOF),
    // and must forward abortSignal through exec creation, startup, and inspection.
    expect(execCalls[0]?.AttachStdin).toBeUndefined();
    expect(execCalls[0]?.abortSignal).toBe(controller.signal);
    expect(start).toHaveBeenCalledWith({
      hijack: true,
      stdin: false,
      abortSignal: controller.signal,
    });
    expect(inspect).toHaveBeenCalledWith({ abortSignal: controller.signal });
    expect(pieces).toEqual([
      { stream: "stdout", data: "hello\n" },
      { stream: "stderr", data: "partial" },
      { stream: "stderr", data: "\ncommand timed out after 5000 ms\n" },
    ]);
    // Streaming mode must not retain the full output in memory.
    expect(result).toEqual({ stdout: "", stderr: "", code: 124 });
  });

  it("cancels Docker exec startup via abortSignal when the caller aborts mid-start", async () => {
    const controller = new AbortController();
    const container = {
      exec: vi.fn(async () => ({
        start: vi.fn(
          ({ abortSignal }: { abortSignal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              abortSignal?.addEventListener(
                "abort",
                () => reject(abortSignal.reason ?? new Error("aborted")),
                { once: true },
              );
            }),
        ),
        inspect: vi.fn(),
      })),
    } as unknown as Docker.Container;

    const pending = runContainerCommand(container, ["echo", "hi"], {
      signal: controller.signal,
      onOutput: () => undefined,
    });
    await vi.waitFor(() => expect(container.exec).toHaveBeenCalledOnce());
    controller.abort(new Error("client disconnected"));
    await expect(pending).rejects.toThrow("client disconnected");
  });

  it("destroys the stream and rejects when non-streaming output exceeds maxOutputBytes", async () => {
    const stream = new PassThrough();
    const destroy = vi.spyOn(stream, "destroy");
    const container = {
      exec: vi.fn(async () => ({
        start: async () => stream,
        inspect: async () => ({ ExitCode: 0 }),
      })),
    } as unknown as Docker.Container;

    const promise = runContainerCommand(container, ["yes"], { maxOutputBytes: 64 });
    await vi.waitFor(() => expect(container.exec).toHaveBeenCalledOnce());
    stream.write(Buffer.alloc(100, 0x61));

    await expect(promise).rejects.toThrow(/exceeded 64 bytes/);
    expect(destroy).toHaveBeenCalled();
  });
});

describe("createDockerStreamDemuxer bounds", () => {
  it("falls back to raw output when a pending header declares an oversized frame", () => {
    const demuxer = createDockerStreamDemuxer();
    const bogus = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x7f, 0xff, 0xff, 0xff, 0x41, 0x42]);
    const live = demuxer.push(bogus);
    expect(live.map((c) => c.data).join("")).toBe(bogus.toString("utf8"));
  });

  it("flushes malformed trailing bytes in multiplex mode instead of buffering forever", () => {
    const demuxer = createDockerStreamDemuxer();
    const valid = frame(1, "ok\n");
    const corrupt = Buffer.from([0x09, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x61, 0x62]);
    const live = demuxer.push(Buffer.concat([valid, corrupt]));
    expect(live).toEqual([
      { stream: "stdout", data: "ok\n" },
      { stream: "stdout", data: corrupt.toString("utf8") },
    ]);
  });
});

describe("POST /computers/:id/exec streaming", () => {
  beforeEach(() => {
    mock.exec.mockReset();
    mock.inspect.mockReset();
    mock.inspect.mockResolvedValue({
      State: { Running: true },
      Config: {
        Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
      },
    });
  });

  it("destroys the Docker stream when the client cancels the exec response", async () => {
    const stream = new PassThrough();
    const destroyed = deferred<void>();
    const origDestroy = stream.destroy.bind(stream);
    stream.destroy = ((error?: Error) => {
      destroyed.resolve();
      return origDestroy(error);
    }) as typeof stream.destroy;
    mock.exec.mockResolvedValue({
      start: async () => stream,
      inspect: async () => ({ ExitCode: 0 }),
    });

    const response = await supervisorApp.request("/computers/computer-1/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
      },
      body: JSON.stringify({ argv: ["yes"] }),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    stream.write(frame(1, "first\n"));
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toContain('"first\\n"');

    await reader.cancel();
    await destroyed.promise;
    expect(mock.exec.mock.calls[0]?.[0]?.AttachStdin).toBeUndefined();
  });

  it("applies backpressure by pausing the Docker stream until the client pulls", async () => {
    const stream = new PassThrough();
    const pause = vi.spyOn(stream, "pause");
    const resume = vi.spyOn(stream, "resume");
    mock.exec.mockResolvedValue({
      start: async () => stream,
      inspect: async () => ({ ExitCode: 0 }),
    });

    const response = await supervisorApp.request("/computers/computer-2/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
      },
      body: JSON.stringify({ argv: ["yes"] }),
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(mock.exec).toHaveBeenCalledOnce());
    // Emit multiple chunks before anyone reads so the ReadableStream queue fills.
    stream.write(frame(1, "chunk-1\n"));
    stream.write(frame(1, "chunk-2\n"));
    await vi.waitFor(() => expect(pause).toHaveBeenCalled());

    const reader = response.body!.getReader();
    await reader.read();
    await reader.read();
    await vi.waitFor(() => expect(resume).toHaveBeenCalled());
    stream.end();
    while (!(await reader.read()).done) {
      // drain
    }
  });

  it("streams large file reads with backpressure and enforces 413/404 and mid-stream limits", async () => {
    // 1. Streaming multi-chunk base64 response with backpressure.
    const stream = new PassThrough();
    const pause = vi.spyOn(stream, "pause");
    const resume = vi.spyOn(stream, "resume");
    const container = {
      exec: vi.fn(async () => ({
        start: async () => stream,
        inspect: async () => ({ ExitCode: 0 }),
      })),
    } as unknown as Docker.Container;

    const part1 = Buffer.from("hello ").toString("base64");
    const part2 = Buffer.from("world!").toString("base64");
    const outcomePromise = readContainerFile(container, "/home/rakazo/big.bin", {
      maxBytes: 12,
      signalMidStreamOverflow: true,
    });
    await vi.waitFor(() => expect(container.exec).toHaveBeenCalledOnce());
    stream.write(frame(1, part1));
    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("stream");
    expect(pause).toHaveBeenCalled();
    if (outcome.kind !== "stream") return;

    const reader = outcome.body.getReader();
    const chunks: Uint8Array[] = [];
    const first = await reader.read();
    if (first.value) chunks.push(first.value);
    await vi.waitFor(() => expect(resume).toHaveBeenCalled());
    stream.write(frame(1, part2));
    stream.end();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { content: string };
    expect(Buffer.from(parsed.content, "base64").toString("utf8")).toBe("hello world!");

    // 2. Exit 42 before output yields too_large (HTTP 413).
    const tooLargeContainer = {
      exec: vi.fn(async () => ({
        start: async () => Readable.from([]),
        inspect: async () => ({ ExitCode: 42 }),
      })),
    } as unknown as Docker.Container;
    expect(
      await readContainerFile(tooLargeContainer, "/home/rakazo/huge.bin", { maxBytes: 10 }),
    ).toEqual({ kind: "too_large" });

    // 3. Opted-in mid-stream exit 42 (file grows after chunk 1) closes cleanly with tooLarge: true.
    const growExitStream = new PassThrough();
    const growExitContainer = {
      exec: vi.fn(async () => ({
        start: async () => growExitStream,
        inspect: async () => ({ ExitCode: 42 }),
      })),
    } as unknown as Docker.Container;
    const growExitPromise = readContainerFile(growExitContainer, "/home/rakazo/grow.bin", {
      maxBytes: 6,
      signalMidStreamOverflow: true,
    });
    await vi.waitFor(() => expect(growExitContainer.exec).toHaveBeenCalledOnce());
    growExitStream.write(frame(1, part1));
    const growExitOutcome = await growExitPromise;
    expect(growExitOutcome.kind).toBe("stream");
    if (growExitOutcome.kind !== "stream") return;
    const growExitReader = growExitOutcome.body.getReader();
    const growExitChunks: Uint8Array[] = [];
    const growFirst = await growExitReader.read();
    if (growFirst.value) growExitChunks.push(growFirst.value);
    growExitStream.end();
    while (true) {
      const next = await growExitReader.read();
      if (next.done) break;
      growExitChunks.push(next.value);
    }
    expect(JSON.parse(Buffer.concat(growExitChunks).toString("utf8"))).toEqual({
      content: part1,
      tooLarge: true,
    });

    // 4. Opted-in mid-stream encoded-byte overflow also closes with tooLarge: true.
    const growStream = new PassThrough();
    const growContainer = {
      exec: vi.fn(async () => ({
        start: async () => growStream,
        inspect: async () => ({ ExitCode: 0 }),
      })),
    } as unknown as Docker.Container;
    const growPromise = readContainerFile(growContainer, "/home/rakazo/grow.bin", {
      maxBytes: 6,
      signalMidStreamOverflow: true,
    });
    await vi.waitFor(() => expect(growContainer.exec).toHaveBeenCalledOnce());
    growStream.write(frame(1, part1));
    const growOutcome = await growPromise;
    expect(growOutcome.kind).toBe("stream");
    if (growOutcome.kind !== "stream") return;
    const growReader = growOutcome.body.getReader();
    const growChunks: Uint8Array[] = [];
    const growChunk1 = await growReader.read();
    if (growChunk1.value) growChunks.push(growChunk1.value);
    growStream.write(frame(1, part2));
    growStream.end();
    while (true) {
      const next = await growReader.read();
      if (next.done) break;
      growChunks.push(next.value);
    }
    expect(JSON.parse(Buffer.concat(growChunks).toString("utf8"))).toEqual({
      content: part1,
      tooLarge: true,
    });

    // 5. Legacy callers without opt-in spool bounded reads to disk and return too_large (HTTP 413) on mid-stream overflow.
    const legacyGrowStream = new PassThrough();
    const legacyGrowContainer = {
      exec: vi.fn(async () => ({
        start: async () => legacyGrowStream,
        inspect: async () => ({ ExitCode: 42 }),
      })),
    } as unknown as Docker.Container;
    const legacyGrowPromise = readContainerFile(legacyGrowContainer, "/home/rakazo/grow.bin", {
      maxBytes: 6,
    });
    await vi.waitFor(() => expect(legacyGrowContainer.exec).toHaveBeenCalledOnce());
    legacyGrowStream.write(frame(1, part1));
    legacyGrowStream.end();
    expect(await legacyGrowPromise).toEqual({ kind: "too_large" });

    const legacyOverflowStream = new PassThrough();
    const legacyOverflowContainer = {
      exec: vi.fn(async () => ({
        start: async () => legacyOverflowStream,
        inspect: async () => ({ ExitCode: 0 }),
      })),
    } as unknown as Docker.Container;
    const legacyOverflowPromise = readContainerFile(
      legacyOverflowContainer,
      "/home/rakazo/grow.bin",
      { maxBytes: 6 },
    );
    await vi.waitFor(() => expect(legacyOverflowContainer.exec).toHaveBeenCalledOnce());
    legacyOverflowStream.write(frame(1, part1));
    legacyOverflowStream.write(frame(1, part2));
    legacyOverflowStream.end();
    expect(await legacyOverflowPromise).toEqual({ kind: "too_large" });

    // 6. Non-42 mid-stream errors still fail the stream instead of closing valid JSON.
    const failStream = new PassThrough();
    const failContainer = {
      exec: vi.fn(async () => ({
        start: async () => failStream,
        inspect: async () => ({ ExitCode: 1 }),
      })),
    } as unknown as Docker.Container;
    const failPromise = readContainerFile(failContainer, "/home/rakazo/fail.bin", {
      maxBytes: 12,
      signalMidStreamOverflow: true,
    });
    await vi.waitFor(() => expect(failContainer.exec).toHaveBeenCalledOnce());
    failStream.write(frame(1, part1));
    const failOutcome = await failPromise;
    expect(failOutcome.kind).toBe("stream");
    if (failOutcome.kind !== "stream") return;
    const failReader = failOutcome.body.getReader();
    await failReader.read();
    failStream.write(frame(2, "disk read failed"));
    failStream.end();
    await expect(
      (async () => {
        while (!(await failReader.read()).done) {
          // drain until error
        }
      })(),
    ).rejects.toThrow("disk read failed");
  });

  it("carries mid-stream exit 42 as tooLarge JSON for overflow=marker and HTTP 413 for legacy callers", async () => {
    const optedInStream = new PassThrough();
    mock.exec.mockResolvedValueOnce({
      start: async () => optedInStream,
      inspect: async () => ({ ExitCode: 42 }),
    });

    const part1 = Buffer.from("hello ").toString("base64");
    const optedInPromise = supervisorApp.request(
      "/computers/computer-3/files?path=grow.bin&mode=read&maxBytes=6&overflow=marker",
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
          "x-rakazo-bot-id": "bot",
          "x-rakazo-space-id": "space",
        },
      },
    );
    await vi.waitFor(() => expect(mock.exec).toHaveBeenCalledTimes(1));
    optedInStream.write(frame(1, part1));
    const optedInResponse = await optedInPromise;
    expect(optedInResponse.status).toBe(200);
    optedInStream.end();
    expect(await optedInResponse.json()).toEqual({ content: part1, tooLarge: true });

    const legacyStream = new PassThrough();
    mock.exec.mockResolvedValueOnce({
      start: async () => legacyStream,
      inspect: async () => ({ ExitCode: 42 }),
    });
    const legacyPromise = supervisorApp.request(
      "/computers/computer-3/files?path=grow.bin&mode=read&maxBytes=6",
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
          "x-rakazo-bot-id": "bot",
          "x-rakazo-space-id": "space",
        },
      },
    );
    await vi.waitFor(() => expect(mock.exec).toHaveBeenCalledTimes(2));
    legacyStream.write(frame(1, part1));
    legacyStream.end();
    const legacyResponse = await legacyPromise;
    expect(legacyResponse.status).toBe(413);
    expect(await legacyResponse.json()).toEqual({ error: "computer file exceeds 6 bytes" });

    // Legacy bounded read within limit streams the spooled content back as HTTP 200 JSON.
    const legacyOkStream = new PassThrough();
    mock.exec.mockResolvedValueOnce({
      start: async () => legacyOkStream,
      inspect: async () => ({ ExitCode: 0 }),
    });
    const legacyOkPromise = supervisorApp.request(
      "/computers/computer-3/files?path=ok.bin&mode=read&maxBytes=6",
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
          "x-rakazo-bot-id": "bot",
          "x-rakazo-space-id": "space",
        },
      },
    );
    await vi.waitFor(() => expect(mock.exec).toHaveBeenCalledTimes(3));
    legacyOkStream.write(frame(1, part1));
    legacyOkStream.end();
    const legacyOkResponse = await legacyOkPromise;
    expect(legacyOkResponse.status).toBe(200);
    expect(await legacyOkResponse.json()).toEqual({ content: part1 });
  });

  it("releases spooled temp files and direct Docker streams on HEAD file reads", async () => {
    const part1 = Buffer.from("hello ").toString("base64");
    const beforeSpools = new Set(
      (await readdir(tmpdir())).filter((name) => name.startsWith("rakazo-file-read-")),
    );

    // 1. Legacy spooled HEAD read unlinks immediately and closes its spool handle on cancel.
    let headHandleClosed = false;
    mock.onNextClose = async () => {
      headHandleClosed = true;
    };
    const legacyStream = new PassThrough();
    mock.exec.mockResolvedValueOnce({
      start: async () => legacyStream,
      inspect: async () => ({ ExitCode: 0 }),
    });
    const legacyHeadPromise = supervisorApp.request(
      "/computers/computer-3/files?path=ok.bin&mode=read&maxBytes=6",
      {
        method: "HEAD",
        headers: {
          authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
          "x-rakazo-bot-id": "bot",
          "x-rakazo-space-id": "space",
        },
      },
    );
    await vi.waitFor(() => expect(mock.exec).toHaveBeenCalledTimes(1));
    legacyStream.write(frame(1, part1));
    legacyStream.end();
    const legacyHead = await legacyHeadPromise;
    expect(legacyHead.status).toBe(200);
    expect(await legacyHead.text()).toBe("");
    expect(headHandleClosed).toBe(true);
    const afterSpools = (await readdir(tmpdir())).filter(
      (name) => name.startsWith("rakazo-file-read-") && !beforeSpools.has(name),
    );
    expect(afterSpools).toEqual([]);

    // 2. Direct streaming HEAD read destroys the paused Docker stream instead of leaking it.
    const directStream = new PassThrough();
    const destroy = vi.spyOn(directStream, "destroy");
    mock.exec.mockResolvedValueOnce({
      start: async () => directStream,
      inspect: async () => ({ ExitCode: 0 }),
    });
    const directHeadPromise = supervisorApp.request(
      "/computers/computer-3/files?path=ok.bin&mode=read&maxBytes=6&overflow=marker",
      {
        method: "HEAD",
        headers: {
          authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
          "x-rakazo-bot-id": "bot",
          "x-rakazo-space-id": "space",
        },
      },
    );
    await vi.waitFor(() => expect(mock.exec).toHaveBeenCalledTimes(2));
    directStream.write(frame(1, part1));
    const directHead = await directHeadPromise;
    expect(directHead.status).toBe(200);
    expect(await directHead.text()).toBe("");
    expect(destroy).toHaveBeenCalled();

    // 3. Spool path is already unlinked while open, and aborting closes the handle without body.cancel().
    let abortHandleClosed = false;
    mock.onNextClose = async () => {
      abortHandleClosed = true;
    };
    const abortStream = new PassThrough();
    const abortController = new AbortController();
    const abortContainer = {
      exec: vi.fn(async () => ({
        start: async () => abortStream,
        inspect: async () => ({ ExitCode: 0 }),
      })),
    } as unknown as Docker.Container;
    const abortOutcomePromise = readContainerFile(abortContainer, "/home/rakazo/ok.bin", {
      maxBytes: 6,
      signal: abortController.signal,
    });
    await vi.waitFor(() => expect(abortContainer.exec).toHaveBeenCalledOnce());
    abortStream.write(frame(1, part1));
    abortStream.end();
    const abortOutcome = await abortOutcomePromise;
    expect(abortOutcome.kind).toBe("stream");
    if (abortOutcome.kind !== "stream") return;
    // Even before reading or aborting, no named spool file remains in tmpdir.
    expect(
      (await readdir(tmpdir())).filter(
        (name) => name.startsWith("rakazo-file-read-") && !beforeSpools.has(name),
      ),
    ).toEqual([]);
    const abortReader = abortOutcome.body.getReader();
    // Drain the initial '{"content":"' chunk so the next read invokes pull().
    await abortReader.read();
    const pendingRead = abortReader.read();
    abortController.abort(new Error("client disconnected"));
    await expect(pendingRead).rejects.toThrow("client disconnected");
    await vi.waitFor(() => expect(abortHandleClosed).toBe(true));

    // Also verify aborting before any reader attaches closes the spool handle without body.cancel().
    let unconsumedHandleClosed = false;
    mock.onNextClose = async () => {
      unconsumedHandleClosed = true;
    };
    const unconsumedStream = new PassThrough();
    const unconsumedAbort = new AbortController();
    const unconsumedContainer = {
      exec: vi.fn(async () => ({
        start: async () => unconsumedStream,
        inspect: async () => ({ ExitCode: 0 }),
      })),
    } as unknown as Docker.Container;
    const unconsumedPromise = readContainerFile(unconsumedContainer, "/home/rakazo/ok.bin", {
      maxBytes: 6,
      signal: unconsumedAbort.signal,
    });
    await vi.waitFor(() => expect(unconsumedContainer.exec).toHaveBeenCalledOnce());
    unconsumedStream.write(frame(1, part1));
    unconsumedStream.end();
    const unconsumedOutcome = await unconsumedPromise;
    expect(unconsumedOutcome.kind).toBe("stream");
    expect(unconsumedHandleClosed).toBe(false);
    unconsumedAbort.abort(new Error("client disconnected early"));
    await vi.waitFor(() => expect(unconsumedHandleClosed).toBe(true));

    // 4. Aborting while EOF spool close() is held rejects the pending read before cleanup resumes.
    const closeStarted = deferred();
    const closeGate = deferred();
    mock.onNextClose = async () => {
      closeStarted.resolve();
      await closeGate.promise;
    };
    try {
      const eofStream = new PassThrough();
      const eofAbort = new AbortController();
      const eofContainer = {
        exec: vi.fn(async () => ({
          start: async () => eofStream,
          inspect: async () => ({ ExitCode: 0 }),
        })),
      } as unknown as Docker.Container;
      const eofOutcomePromise = readContainerFile(eofContainer, "/home/rakazo/ok.bin", {
        maxBytes: 6,
        signal: eofAbort.signal,
      });
      await vi.waitFor(() => expect(eofContainer.exec).toHaveBeenCalledOnce());
      eofStream.write(frame(1, part1));
      eofStream.end();
      const eofOutcome = await eofOutcomePromise;
      expect(eofOutcome.kind).toBe("stream");
      if (eofOutcome.kind !== "stream") return;

      const eofReader = eofOutcome.body.getReader();
      await eofReader.read(); // '{"content":"'
      await eofReader.read(); // returns part1 from the unlinked spool handle
      const pendingEofRead = eofReader.read();
      await closeStarted.promise;
      let outcome:
        | { settled: "resolved"; value: unknown }
        | { settled: "rejected"; error: unknown }
        | undefined;
      void pendingEofRead.then(
        (value) => {
          outcome = { settled: "resolved", value };
        },
        (error: unknown) => {
          outcome = { settled: "rejected", error };
        },
      );
      eofAbort.abort(new Error("aborted during eof cleanup"));
      await flush();
      expect(outcome?.settled).toBe("rejected");
      if (outcome?.settled === "rejected") {
        expect(outcome.error).toBeInstanceOf(Error);
        expect((outcome.error as Error).message).toBe("aborted during eof cleanup");
      }
      closeGate.resolve();
    } finally {
      mock.onNextClose = undefined;
      closeGate.resolve();
    }
    await vi.waitFor(async () => {
      const remaining = (await readdir(tmpdir())).filter(
        (name) => name.startsWith("rakazo-file-read-") && !beforeSpools.has(name),
      );
      expect(remaining).toEqual([]);
    });
  });

  it("caps writeContainerFile diagnostics after demultiplexing without corrupting frames", async () => {
    const stream = new Duplex({
      write(_chunk, _encoding, callback) {
        callback();
      },
      read() {},
    });
    const container = {
      exec: vi.fn(async () => ({
        start: async () => stream,
        inspect: async () => ({ ExitCode: 1 }),
      })),
    } as unknown as Docker.Container;

    const writing = writeContainerFile(container, "/home/rakazo/out.txt", Buffer.from("abc"));
    await vi.waitFor(() => expect(container.exec).toHaveBeenCalledOnce());
    // Write > 64 KiB of framed stdout (crossing the diagnostic cap mid-frame) followed by stderr.
    stream.push(frame(1, "x".repeat(70_000)));
    stream.push(frame(2, "permission denied\n"));
    stream.push(null);

    await expect(writing).rejects.toThrow(/^permission denied\n$/);

    // Multi-byte UTF-8 stderr is capped by UTF-8 byte budget without splitting code points.
    const emojiStream = new Duplex({
      write(_chunk, _encoding, callback) {
        callback();
      },
      read() {},
    });
    const emojiContainer = {
      exec: vi.fn(async () => ({
        start: async () => emojiStream,
        inspect: async () => ({ ExitCode: 1 }),
      })),
    } as unknown as Docker.Container;

    const emojiWriting = writeContainerFile(
      emojiContainer,
      "/home/rakazo/out.txt",
      Buffer.from("abc"),
    );
    await vi.waitFor(() => expect(emojiContainer.exec).toHaveBeenCalledOnce());
    // 1 byte + 17_000 4-byte emojis = 68_001 UTF-8 bytes; boundary lands inside an emoji.
    emojiStream.push(frame(2, `x${"🔥".repeat(17_000)}`));
    emojiStream.push(null);

    const err = await emojiWriting.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.from(message, "utf8").toString("utf8")).toBe(message);
    expect(message.startsWith("x🔥")).toBe(true);
  });
});
