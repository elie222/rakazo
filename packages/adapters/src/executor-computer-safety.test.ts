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
});
