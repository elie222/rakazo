import { describe, expect, it } from "vitest";
import { isProtectedComputerLifecycleCommand } from "./executor.js";

describe("computer lifecycle command guard", () => {
  it("rejects commands that can destroy a graphical bot's desktop", () => {
    for (const command of [
      "pkill chromium",
      "killall chrome",
      "kill -9 1234",
      "xkill",
      "systemctl restart chromium",
      "rm -rf ~/.browser-profiles/chromium",
      "rm -f /tmp/.X1-lock",
    ]) {
      expect(isProtectedComputerLifecycleCommand(command)).toBe(true);
    }
  });

  it("keeps ordinary shell work available", () => {
    expect(isProtectedComputerLifecycleCommand("pwd && ls -la")).toBe(false);
    expect(isProtectedComputerLifecycleCommand("node scripts/check.js")).toBe(false);
  });
});
