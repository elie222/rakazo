import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { speechToWav } from "./speech-to-wav.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => vi.clearAllMocks());

function processFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

it("converts over pipes, isolates credentials, disables network protocols, and limits threads", async () => {
  const child = processFixture();
  const signal = new AbortController().signal;
  const result = speechToWav(new Uint8Array([1]), signal, 100);
  child.stdout.write(Buffer.alloc(80));
  child.emit("close", 0);
  expect(await result).toHaveLength(80);
  expect(spawn).toHaveBeenCalledWith(
    "ffmpeg",
    expect.arrayContaining(["-protocol_whitelist", "pipe", "-threads", "1", "16000", "pcm_s16le"]),
    expect.objectContaining({ signal, killSignal: "SIGKILL", env: { PATH: process.env.PATH } }),
  );
});

it("kills the exact converter child when its output exceeds the cap", async () => {
  const child = processFixture();
  const result = speechToWav(new Uint8Array([1]), new AbortController().signal, 70);
  child.stdout.write(Buffer.alloc(80));
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  child.emit("close", null);
  await expect(result).rejects.toThrow("too large");
});

it("fails safely on an absent decoder, invalid input, or cancellation", async () => {
  for (const code of ["ENOENT", "ABORT_ERR", undefined]) {
    const child = processFixture();
    const controller = new AbortController();
    const result = speechToWav(new Uint8Array([1]), controller.signal, 100);
    if (code === "ABORT_ERR") controller.abort();
    if (code) child.emit("error", Object.assign(new Error("private path"), { code }));
    child.emit("close", 1);
    await expect(result).rejects.toThrow(
      code === "ENOENT" ? "Install ffmpeg" : code ? "cancelled" : "decoded",
    );
  }
  expect(() => speechToWav(new Uint8Array(), AbortSignal.abort(), 100)).toThrow();
});
