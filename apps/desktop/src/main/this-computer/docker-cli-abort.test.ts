import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { runDocker } from "./docker-cli.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

afterEach(() => vi.resetAllMocks());

const options = { cwd: ".", env: {}, timeoutMs: 10_000 };

it("does not spawn Docker when the command is already aborted", async () => {
  vi.mocked(spawn).mockReturnValueOnce(new EventEmitter() as ReturnType<typeof spawn>);
  const result = await runDocker("fake-docker", ["info"], { ...options, signal: AbortSignal.abort() });
  expect(result).toEqual({ code: 130, stdout: "", stderr: "" });
  expect(spawn).not.toHaveBeenCalled();
});

it("still handles an abort after spawning", async () => {
  const controller = new AbortController();
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as ReturnType<typeof spawn>);

  const result = runDocker("fake-docker", ["info"], { ...options, signal: controller.signal });
  expect(spawn).toHaveBeenCalledTimes(1);
  controller.abort();

  expect(await result).toEqual({ code: 130, stdout: "", stderr: "" });
  expect(child.stdout.destroyed).toBe(true);
  expect(child.stderr.destroyed).toBe(true);
});
