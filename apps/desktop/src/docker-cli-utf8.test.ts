import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDocker } from "./docker-cli.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

afterEach(() => vi.clearAllMocks());

describe("runDocker UTF-8 output", () => {
  it.each(["stdout", "stderr"] as const)(
    "preserves split UTF-8 in %s captures and complete lines",
    async (stream) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
      const lines: string[] = [];
      const pending = runDocker("fake-docker", [], {
        cwd: ".",
        env: {},
        timeoutMs: 10_000,
        onLine: (line) => lines.push(line),
      });
      const text = "中文😀\r\n進度\r完成\n最後";
      for (const byte of Buffer.from(text)) child[stream].write(Buffer.from([byte]));
      child.stdout.end();
      child.stderr.end();
      await Promise.all([finished(child.stdout), finished(child.stderr)]);
      child.emit("close", 0);
      expect(await pending).toEqual({ code: 0, stdout: "", stderr: "", [stream]: text });
      expect(lines).toEqual(["中文😀", "完成", "最後"]);
    },
  );

  it("keeps stdout and stderr decoder state separate", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const lines: string[] = [];
    const pending = runDocker("fake-docker", [], {
      cwd: ".",
      env: {},
      timeoutMs: 10_000,
      onLine: (line) => lines.push(line),
    });
    const stdout = Buffer.from("中");
    const stderr = Buffer.from("😀");
    child.stdout.write(stdout.subarray(0, 1));
    child.stderr.write(stderr.subarray(0, 2));
    child.stdout.end(stdout.subarray(1));
    child.stderr.end(stderr.subarray(2));
    await Promise.all([finished(child.stdout), finished(child.stderr)]);
    child.emit("close", 3);
    expect(await pending).toEqual({ code: 3, stdout: "中", stderr: "😀" });
    expect(lines).toEqual(["中", "😀"]);
  });

  it.each(["stdout", "stderr"] as const)(
    "flushes one replacement character for an incomplete final %s sequence",
    async (stream) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
      const lines: string[] = [];
      const pending = runDocker("fake-docker", [], {
        cwd: ".",
        env: {},
        timeoutMs: 10_000,
        onLine: (line) => lines.push(line),
      });
      child[stream].write(Buffer.from([0xf0]));
      child[stream].write(Buffer.from([0x9f]));
      child.stdout.end();
      child.stderr.end();
      await Promise.all([finished(child.stdout), finished(child.stderr)]);
      child.emit("close", 0);
      expect(await pending).toEqual({ code: 0, stdout: "", stderr: "", [stream]: "\ufffd" });
      expect(lines).toEqual(["\ufffd"]);
    },
  );
});
