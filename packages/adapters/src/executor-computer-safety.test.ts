import { describe, expect, it } from "vitest";
import { isProtectedComputerLifecycleCommand } from "./executor.js";

describe("computer lifecycle command guard", () => {
  it("rejects commands that can destroy a graphical bot's desktop", () => {
    for (const command of [
      "pkill chromium",
      "killall chrome",
      "kill -9 1234",
      "k\\ill -9 1234",
      "xkill",
      "systemctl restart chromium",
      "systemctl --user restart chromium",
      "service chromium restart",
      "rm -rf ~/.browser-profiles/chromium",
      'rm -rf "$HOME/.browser-profiles/chromium"',
      "rm -f /tmp/.X1-lock",
      "bash -c 'pkill chromium'",
      'bash -lc "killall chrome"',
      "bash -o posix -c 'pkill chromium'",
      "bash --rcfile /tmp/bashrc -c 'pkill chromium'",
      "sh -c 'systemctl restart chromium'",
      `bash -c 'eval "pkill chromium"'`,
      'bash -lc "source /tmp/kill-chrome.sh"',
      "printf 'pkill chromium\\n' > /tmp/x; . /tmp/x",
      "bash -c `pkill chromium`",
      'bash <<< "pkill chromium"',
      "$KILLER chromium",
      'rm -rf "$TARGET/.browser-profiles/chromium"',
    ]) {
      expect(isProtectedComputerLifecycleCommand(command)).toBe(true);
    }
  });

  it("keeps ordinary shell work available", () => {
    expect(isProtectedComputerLifecycleCommand("pwd && ls -la")).toBe(false);
    expect(isProtectedComputerLifecycleCommand("node scripts/check.js")).toBe(false);
    expect(isProtectedComputerLifecycleCommand("systemctl status chromium")).toBe(false);
    expect(isProtectedComputerLifecycleCommand('rm -f "$WORKSPACE/tmp.txt"')).toBe(false);
    expect(isProtectedComputerLifecycleCommand("printf '%s\\n' *.txt && pwd")).toBe(false);
  });

  it.each([
    "find . -maxdepth 2 -type d -name .git -print",
    "git -C . status --short",
    "git add .",
    "git add then .",
    "ls . && git -C . worktree list --porcelain",
    "set -eu\npwd\nfind . -maxdepth 2 -type d -name .git -print",
    "git worktree add ../review-worktree origin/main",
    "find /tmp/. -maxdepth 1 -type d",
    "git diff -- .",
    "printf '%s' 'pk\\\nill chromium'",
    "printf '%s' 'pk\\\nill' chromium",
    "printf '%s' 'line one\nline two'",
  ])("allows repository paths without treating dot arguments as sourcing: %s", (command) => {
    expect(isProtectedComputerLifecycleCommand(command)).toBe(false);
  });

  it.each([
    ". /tmp/script.sh",
    "pwd; . /tmp/script.sh",
    "pwd\n. /tmp/script.sh",
    "find . -maxdepth 1 && . /tmp/script.sh",
    "command . /tmp/script.sh",
    "builtin . /tmp/script.sh",
    "command -p . /tmp/script.sh",
    "true && > /tmp/output . /tmp/script.sh",
    "2> /tmp/output . /tmp/script.sh",
    "if true; then . /tmp/script.sh; fi",
    "bash -c 'pwd\n. /tmp/script.sh'",
    "pk\\\nill chromium",
    "! . /tmp/script.sh",
    "if false; then :; elif . /tmp/script.sh; then :; fi",
    "{ . /tmp/script.sh; }",
    "coproc . /tmp/script.sh",
    "coproc worker . /tmp/script.sh",
    "function f { . /tmp/script.sh; }",
    "function f { . /tmp/script.sh; }; f",
  ])("continues blocking executable sourcing and lifecycle operations: %s", (command) => {
    expect(isProtectedComputerLifecycleCommand(command)).toBe(true);
  });
});
