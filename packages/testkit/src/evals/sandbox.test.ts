import type { AdapterContext, ProcessEvent } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { EvalSandboxProvider } from "./sandbox.js";

const context: AdapterContext = {
  operationId: "eval",
  traceId: "eval",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

describe("honest offline eval shell results", () => {
  it("does not claim a shell-created file exists when it never executed the command", async () => {
    const sandbox = new EvalSandboxProvider();
    const computer = await sandbox.provision({ botId: "bot", homePath: "/fixture" }, context);
    const events: ProcessEvent[] = [];
    for await (const event of sandbox.execute(
      computer,
      {
        argv: [
          "bash",
          "-c",
          "wrapper",
          "rakazo-background-launch",
          "computer",
          "run",
          "call",
          "mkdir -p results && printf 'Hello, workshop!' > results/greeting.txt",
        ],
      },
      context,
    ))
      events.push(event);
    expect(events).toContainEqual({ type: "exit", code: 127 });
    expect(events.some((event) => event.type === "stdout")).toBe(false);
    await expect(sandbox.readFile(computer, "results/greeting.txt", context)).rejects.toThrow();
    expect(sandbox.harnessIssues).toHaveLength(1);
    // The ordinary file tools still execute and produce independently readable artifacts.
    await sandbox.writeFile(
      computer,
      {
        path: "results/greeting.txt",
        content: new TextEncoder().encode("Hello, workshop!"),
      },
      context,
    );
    expect(
      new TextDecoder().decode(await sandbox.readFile(computer, "results/greeting.txt", context)),
    ).toBe("Hello, workshop!");
    await sandbox.destroy(computer, context);
  });
});
