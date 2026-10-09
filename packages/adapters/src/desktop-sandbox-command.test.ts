import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProcessEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";

const ctx = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

describe("desktop command execution", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("does not pass the program or its arguments through a shell", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rakazo-desktop-command-"));
    roots.push(root);
    const desktop = new DesktopSandboxProvider({ root });
    const computer = await desktop.provision({ botId: "cmd", homePath: "/unused" }, ctx);
    const marker = path.join(computer.providerRef, "pwned");
    const payload = `$(touch ${marker}); touch ${marker}`;

    const literal = await collect(
      desktop.execute(
        computer,
        {
          argv: [process.execPath, "-e", "process.stdout.write(process.argv[1] ?? '')", payload],
        },
        ctx,
      ),
    );
    expect(literal.code).toBe(0);
    expect(literal.stdout).toBe(payload);
    expect(existsSync(marker)).toBe(false);

    const injected = await collect(
      desktop.execute(computer, { argv: [`${process.execPath}; touch ${marker}`] }, ctx),
    );
    expect(injected.code).toBe(1);
    expect(injected.stderr).toContain("ENOENT");
    expect(existsSync(marker)).toBe(false);

    const binaryNul = await collect(
      desktop.execute(computer, { argv: [`${process.execPath}\0`] }, ctx),
    );
    expect(binaryNul).toMatchObject({ code: 1, stderr: "command rejected\n" });

    const nul = await collect(desktop.execute(computer, { argv: [process.execPath, "a\0b"] }, ctx));
    expect(nul).toMatchObject({ code: 1, stderr: "command rejected\n" });

    const batch = await collect(
      desktop.execute(computer, { argv: ["tool.cmd", "/c", payload] }, ctx),
    );
    expect(batch).toMatchObject({ code: 1, stderr: "command rejected\n" });

    await desktop.destroy(computer, ctx);
  });

  it.skipIf(process.platform === "win32")(
    "runs executable paths containing punctuation and .com",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "rakazo-desktop-command-"));
      roots.push(root);
      const binary = path.join(root, "node$&';.com");
      symlinkSync(process.execPath, binary);
      const desktop = new DesktopSandboxProvider({ root });
      const computer = await desktop.provision({ botId: "cmd", homePath: "/unused" }, ctx);
      const result = await collect(
        desktop.execute(
          computer,
          {
            argv: [binary, "-e", "process.stdout.write('ok')"],
          },
          ctx,
        ),
      );
      expect(result).toEqual({ code: 0, stdout: "ok", stderr: "" });
      await desktop.destroy(computer, ctx);
    },
  );
});

async function collect(events: AsyncIterable<ProcessEvent>) {
  let stdout = "";
  let stderr = "";
  let code = -1;
  for await (const event of events) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") code = event.code;
  }
  return { stdout, stderr, code };
}
