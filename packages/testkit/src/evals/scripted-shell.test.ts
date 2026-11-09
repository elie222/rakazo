import { describe, expect, it } from "vitest";
import { scriptedShell } from "./scripted-shell.js";

describe("scripted eval shell", () => {
  const script = {
    shell: [
      { match: /\bls\b.*extensions/i, output: "midnight" },
      { match: /\bls\b/, output: "ls: cannot access 'x': No such file or directory", exitCode: 2 },
      { match: /\bdf\b/, output: "18G free" },
    ],
    screen: { title: "Example - Browser", dark: true },
  };

  it("keeps a failing check's exit code and stderr, and follows && and ||", () => {
    expect(scriptedShell(script, "ls ~/missing")).toEqual({
      stdout: "",
      stderr: "ls: cannot access 'x': No such file or directory",
      code: 2,
    });
    expect(scriptedShell(script, "ls ~/missing 2>/dev/null && df -h || echo none")).toEqual({
      stdout: "none",
      stderr: "",
      code: 0,
    });
  });

  it("prints echo only when its stdout is not redirected", () => {
    expect(scriptedShell(script, "echo hi > /tmp/x")).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(scriptedShell(script, "echo hi >> /tmp/x")?.stdout).toBe("");
    expect(scriptedShell(script, "echo hi &> /tmp/x")?.stdout).toBe("");
    expect(scriptedShell(script, "echo hi 2>/dev/null")?.stdout).toBe("hi");
  });

  it("covers no command list with an unscripted command in it", () => {
    expect(scriptedShell(script, "uptime")).toBeUndefined();
    expect(scriptedShell(script, "cat /etc/os-release; df -h")).toBeUndefined();
  });

  it("answers the checks a loop mentions, in the order it mentions them", () => {
    expect(
      scriptedShell(script, 'for d in a b; do df -h "$d"; done; ls ~/extensions 2>/dev/null'),
    ).toEqual({ stdout: "18G free\nmidnight", stderr: "", code: 0 });
  });
});
