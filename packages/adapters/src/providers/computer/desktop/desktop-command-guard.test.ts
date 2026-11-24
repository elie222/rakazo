import { describe, expect, it } from "vitest";
import { desktopGuardApplies, protectedComputerLifecycleRefusal } from "./desktop-command-guard.js";

describe("desktop-protection guard", () => {
  it.each([
    "pkill chromium",
    "pkill -f 'chromium --user-data-dir'",
    "killall chrome",
    "killall Xvfb",
    "killall brave-browser",
    "kill -9 -1 2>/dev/null",
    "/usr/bin/pkill x11vnc",
    "kill $(pgrep chromium)",
    "ps aux | grep chrome | awk '{print $2}' | xargs kill -9",
    "killall5 -9",
    "sudo systemctl restart display",
    "service chromium stop",
    "rm -rf ~/.browser-profiles/chromium",
    "mv /home/rakazo/.browser-profiles /tmp/old",
    "find ~/.browser-profiles -name Cookies -delete",
    "rm -f /tmp/.X1-lock",
    "rm -rf /tmp/.X11-unix",
    "printf X > ~/.browser-profiles/chromium/Cookies",
    ": > /tmp/.X1-lock",
    "kill -9 -1",
    "pkill -u rakazo",
    "killall -u rakazo",
    "pkill dbus-daemon",
    "xkill -all",
    "/bin/rm -rf ~/.browser-profiles",
    "chmod -R 000 ~/.browser-profiles",
    "for p in $(pgrep chromium); do kill $p; done",
    "if pgrep chromium; then pkill chromium; fi",
    "bash -lc 'pkill chromium'",
    "timeout 5 pkill chromium",
    "sudo -u rakazo pkill chromium",
    "find ~/.browser-profiles -name 'Singleton*' -exec rm {} \\;",
    'git commit -m "say \\"hi\\"" && pkill chromium',
  ])("refuses %s", (command) => {
    expect(protectedComputerLifecycleRefusal(command)).toBeDefined();
  });

  it.each([
    "cd ~ && (test -d app || git clone https://example.test/app.git)",
    'grep -rn TODO $(grep -rln "export function Lightbox" src)',
    "for n in 1 2 3; do gh issue view $n; done",
    "eval 'ls'; source .venv/bin/activate",
    "python3 - <<'EOF'\nprint(1)\nEOF",
    "kill 1234",
    "pkill -f 'node server.js'",
    "systemctl status chromium",
    "ls -la ~/.browser-profiles",
    "rm -rf build dist",
  ])("runs %s", (command) => {
    expect(protectedComputerLifecycleRefusal(command)).toBeUndefined();
  });
});

it("guards by the computer a run actually uses", () => {
  const stored = { kind: "docker" };
  expect(desktopGuardApplies({ graphical: true, stored })).toBe(true);
  // Not started yet: it may still reuse the running Linux computer.
  expect(desktopGuardApplies({ graphical: true, stored, kind: "wuying" })).toBe(true);
  expect(
    desktopGuardApplies({
      graphical: true,
      stored,
      kind: "wuying",
      lazy: { ready: { kind: "wuying" } },
    }),
  ).toBe(false);
  expect(
    desktopGuardApplies({
      graphical: true,
      stored,
      kind: "wuying",
      lazy: { ready: { kind: "docker" } },
    }),
  ).toBe(true);
  expect(desktopGuardApplies({ graphical: true, stored: { kind: "wuying" } })).toBe(false);
});
