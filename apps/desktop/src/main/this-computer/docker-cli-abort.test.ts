import { spawn } from "node:child_process";
import { expect, it, vi } from "vitest";
import { runDocker } from "./docker-cli.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

it("does not spawn Docker when the command is already aborted", async () => {
  const result = await runDocker("fake-docker", ["info"], {
    cwd: ".",
    env: {},
    timeoutMs: 10_000,
    signal: AbortSignal.abort(),
  });
  expect(result).toEqual({ code: 130, stdout: "", stderr: "" });
  expect(spawn).not.toHaveBeenCalled();
});
