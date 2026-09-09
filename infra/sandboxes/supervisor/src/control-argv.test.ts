import { spawnSync } from "node:child_process";
import path from "node:path";
import { browserProfilePathForScreen } from "@rakazo/core/node/desktop-runtime";
import { describe, expect, it } from "vitest";
import { containerActionStep } from "./supervisor-logic.js";

const profile = browserProfilePathForScreen("test-bot");
const display = ":7";
const controlPath = path.resolve(import.meta.dirname, "../../computer/control.py");

function check(argv: string[]) {
  const probe = spawnSync(
    "python3",
    [
      "-c",
      [
        "import importlib.util, json, sys",
        "from unittest.mock import patch",
        "spec = importlib.util.spec_from_file_location('control_probe', sys.argv[1])",
        "module = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "argv = json.loads(sys.argv[2])",
        "allowed = module.allowed_control_argv(argv, sys.argv[3])",
        "long_lived = module.is_long_lived_control(argv) if allowed else False",
        "if long_lived:",
        "  with patch.object(module.subprocess, 'Popen') as popen:",
        "    popen.return_value.wait.return_value = 0",
        "    module.run_control_argv(argv, sys.argv[3])",
        "    assert popen.call_args.args[0] == argv, 'profile must survive execution'",
        "    assert popen.call_args.kwargs['env']['DISPLAY'] == sys.argv[3]",
        "print(json.dumps({'allowed': allowed, 'longLived': long_lived}))",
      ].join("\n"),
      controlPath,
      JSON.stringify(argv),
      display,
    ],
    { encoding: "utf8" },
  );
  expect(probe.status, probe.stderr).toBe(0);
  return JSON.parse(probe.stdout);
}

describe.each([undefined, profile])(
  "supervisor/controller argv contract (profile=%s)",
  (browserProfile) => {
    it.each([
      { kind: "open" as const, path: "https://example.com" },
      { kind: "launch" as const, application: "chromium", uri: "https://example.com" },
      { kind: "launch" as const, application: "chromium" },
      { kind: "launch" as const, application: "xterm" },
    ])("accepts generated $kind argv and identifies a long-lived process", (action) => {
      const step = containerActionStep(action, display, browserProfile);
      if (!("argv" in step)) throw new Error("expected command");
      if (
        browserProfile &&
        (action.kind === "open" || (action.kind === "launch" && action.application === "chromium"))
      ) {
        expect(step.argv[2]).toBe(`RAKAZO_BROWSER_PROFILE=${browserProfile}`);
      }
      expect(check(step.argv)).toEqual({ allowed: true, longLived: true });
    });

    it("accepts generated keyboard input without treating it as a long-lived process", () => {
      const step = containerActionStep({ kind: "key", key: "Enter" }, display, browserProfile);
      if (!("argv" in step)) throw new Error("expected command");
      expect(check(step.argv)).toEqual({ allowed: true, longLived: false });
    });
  },
);

describe("controller argv restrictions", () => {
  it.each([
    ["env", `DISPLAY=${display}`, `RAKAZO_BROWSER_PROFILE=${profile}`],
    ["env", `DISPLAY=${display}`, "RAKAZO_BROWSER_PROFILE=", "rakazo-browser"],
    ["env", `DISPLAY=${display}`, `RAKAZO_BROWSER_PROFILE=${profile}a`, "rakazo-browser"],
    [
      "env",
      `DISPLAY=${display}`,
      `RAKAZO_BROWSER_PROFILE=${profile.toUpperCase()}`,
      "rakazo-browser",
    ],
    ["env", `DISPLAY=${display}`, `RAKAZO_BROWSER_PROFILE=${profile}`, "xterm"],
    [
      "env",
      `DISPLAY=${display}`,
      `RAKAZO_BROWSER_PROFILE=${profile}`,
      "/usr/bin/xdg-open",
      "https://example.com",
    ],
    ["env", `DISPLAY=${display}`, `RAKAZO_BROWSER_PROFILE=${profile}`, "xdg-open"],
    [
      "env",
      `DISPLAY=${display}`,
      `RAKAZO_BROWSER_PROFILE=${profile}`,
      "rakazo-browser",
      "one",
      "two",
    ],
    ["env", "DISPLAY=:8", `RAKAZO_BROWSER_PROFILE=${profile}`, "rakazo-browser"],
    ["env", "DISPLAY=:8", "xdg-open", "https://example.com"],
    ["env", `DISPLAY=${display}`, "LD_PRELOAD=/tmp/unsafe", "xdg-open", "https://example.com"],
    ["env", `DISPLAY=${display}`, "RAKAZO_BROWSER_PROFILE=/tmp/unsafe", "rakazo-browser"],
    ["env", `DISPLAY=${display}`, `RAKAZO_BROWSER_PROFILE=${profile}/../other`, "rakazo-browser"],
    ["env", `DISPLAY=${display}`, `RAKAZO_BROWSER_PROFILE=${profile}`, "sh", "-c", "true"],
    ["env", `DISPLAY=${display}`, `RAKAZO_BROWSER_PROFILE=${profile}`, "xdotool", "key", "Return"],
    [
      "env",
      `DISPLAY=${display}`,
      `RAKAZO_BROWSER_PROFILE=${profile}`,
      `RAKAZO_BROWSER_PROFILE=${profile}`,
      "rakazo-browser",
    ],
  ])("rejects malformed or unauthorized argv %j", (...argv) => {
    expect(check(argv).allowed).toBe(false);
  });
});
