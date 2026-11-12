import { writeFileSync } from "node:fs";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { AppleContainerSandboxProvider } from "./apple-container-sandbox.js";
import { assertSandboxWorkspaceContract, provisionPrepared } from "./sandbox-test-support.js";

const context: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

describe("AppleContainerSandboxProvider", () => {
  it("starts the image command as the image user without privilege escalation", () => {
    const args = new AppleContainerSandboxProvider({ computerImage: "computer:test" }).runArgs(
      "rakazo-1",
      "bot-a",
    );
    expect(args.slice(0, 9)).toEqual([
      "run",
      "--detach",
      "--rm",
      "--name",
      "rakazo-1",
      "--network",
      "rakazo-1",
      "--label",
      "rakazo.bot-id=bot-a",
    ]);
    expect(args).toContain("--cap-drop");
    expect(args.slice(args.indexOf("--uid"), args.indexOf("--uid") + 4)).toEqual([
      "--uid",
      "1000",
      "--gid",
      "1000",
    ]);
    expect(args.slice(args.indexOf("computer:test"))).toEqual([
      "computer:test",
      "--no-new-privs",
      "--",
      "/usr/bin/env",
      "-u",
      "LD_PRELOAD",
      "/usr/local/bin/rakazo-computer",
    ]);
  });
});

// Opt-in: needs Apple silicon, macOS 26 and a started `container` system service.
describe.runIf(process.env.VERIFY_LOCAL_VM === "1")("AppleContainerSandboxProvider (live)", () => {
  it(
    "runs a computer, its desktop and workspace contract, then removes it",
    async () => {
      const provider = new AppleContainerSandboxProvider({
        cli: process.env.LOCAL_VM_CLI,
        computerImage: process.env.LOCAL_VM_COMPUTER_IMAGE,
      });
      const computer = await provisionPrepared(
        provider,
        { botId: "live-bot", homePath: "/unused" },
        { ...context, botId: "live-bot" },
      );
      expect(await provider.isRunning(computer, context)).toBe(true);
      await assertSandboxWorkspaceContract(provider, computer, context);

      const observation = await provider.observe(computer, { ...context, botId: "live-bot" });
      expect(observation.width).toBeGreaterThan(0);
      if (process.env.LOCAL_VM_SCREENSHOT) {
        writeFileSync(process.env.LOCAL_VM_SCREENSHOT, observation.image);
      }
      const screen = await provider.connectScreen(
        computer,
        { view: "stream" },
        { ...context, botId: "live-bot" },
      );
      expect(screen.url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/embed\.html/);
      const page = await fetch(screen.url!.split("?")[0]!);
      expect(page.ok).toBe(true);
      await screen.close();

      const files: string[] = [];
      for await (const file of provider.exportWorkspace(computer, context)) files.push(file.path);
      expect(files.length).toBeGreaterThan(0);

      await provider.stop(computer);
      expect(await provider.isRunning(computer, context)).toBe(false);
    },
    10 * 60_000,
  );
});
