import type * as ChildProcess from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { ProtectedBrowserRequest } from "../../../browser/protected-browser.js";
import { createProtectedBrowserLauncher } from "./docker-protected-browser.js";

const request: ProtectedBrowserRequest = {
  mode: "sign-in",
  url: "https://example.test",
  steps: [{ kind: "wait", role: "heading", name: "Account" }],
};

const { command } = vi.hoisted(() => ({ command: vi.fn<(args: string[]) => string>() }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcess>();
  const { promisify } = await import("node:util");
  return {
    ...original,
    execFile: Object.assign(() => undefined, {
      [promisify.custom]: async (_file: string, args: string[]) => ({
        stdout: command(args.slice(3)),
      }),
    }),
  };
});

const launch = createProtectedBrowserLauncher({
  image: "fake-browser",
  seccompProfile: "/fake-seccomp.json",
});
const id = "a".repeat(64);
const name = "rakazo-protected-browser-1";

function conflict(slot: string): never {
  throw Object.assign(new Error("conflict"), {
    stderr: `The container name "/${slot}" is already in use`,
  });
}

describe("protected browser slot recovery", () => {
  it("reclaims a slot after create fails without returning its ID, even if another replica wins the retry", async () => {
    command.mockReset();
    command.mockImplementationOnce(() => {
      throw new Error("create timed out");
    });
    await expect(launch(request)).rejects.toMatchObject({
      code: "configuration",
    });

    command.mockImplementation((args) => {
      if (args[0] === "container") {
        const created = new Date(Date.now() - 180_000).toISOString();
        return args.at(-1) === name
          ? `${id} created ${created} true`
          : `${"b".repeat(64)} running ${created} true`;
      }
      if (args[0] === "rm") return id;
      return conflict(args[2]!);
    });
    await expect(launch(request)).rejects.toMatchObject({ code: "capacity" });
    expect(command.mock.calls.slice(1).map(([args]) => args.slice(0, 3))).toEqual([
      ["create", "--name", name],
      ["container", "inspect", "--format"],
      ["rm", id],
      ["create", "--name", name],
      ["create", "--name", "rakazo-protected-browser-2"],
      ["container", "inspect", "--format"],
    ]);
  });

  it.each([
    { status: "running", age: 180_000, label: "true" },
    { status: "created", age: 10_000, label: "true" },
    { status: "created", age: 180_000, label: "<no value>" },
  ])("keeps a $status container with age $age and label $label", async ({ status, age, label }) => {
    command.mockReset();
    command.mockImplementation((args) => {
      if (args[0] === "container") {
        return `${id} ${status} ${new Date(Date.now() - age).toISOString()} ${label}`;
      }
      return conflict(args[2]!);
    });

    await expect(launch(request)).rejects.toMatchObject({
      code: "capacity",
    });
    expect(command.mock.calls.map(([args]) => args[0])).toEqual([
      "create",
      "container",
      "create",
      "container",
    ]);
  });
});
