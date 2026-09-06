import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  browserProfilePathForScreen,
  checkpointScreensCommand,
  completeControlReleaseCommand,
  interactiveScreenCommand,
  prepareBrowserProfileCommand,
  syncSharedBrowserProfileCommand,
} from "./supervisor-logic.js";

const fixtures: string[] = [];
afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "rakazo-profile-test-"));
  fixtures.push(root);
  const home = path.join(root, "home");
  const runtime = path.join(root, "runtime");
  const shared = path.join(home, ".browser-profiles/chromium");
  mkdirSync(shared, { recursive: true });
  mkdirSync(runtime);
  const profile = (bot: string) => browserProfilePathForScreen(bot).replace("/home/rakazo", home);
  const run = (script: string) => {
    // GNU cp's reflink optimization has no macOS equivalent; all copy semantics remain intact.
    const portable =
      process.platform === "darwin" ? script.replaceAll(" --reflink=auto", "") : script;
    return spawnSync(
      "bash",
      ["-eu", "-c", portable.replaceAll("/home/rakazo", home).replaceAll("/tmp/rakazo", runtime)],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
  };
  return { shared, profile, run, runtime };
}

describe("durable browser profiles", () => {
  it("checkpoints viewer-only profiles on stop and promotes the controller last", () => {
    const { shared, runtime, profile, run } = fixture();
    for (const bot of ["controller", "viewer"]) {
      expect(run(prepareBrowserProfileCommand(bot)).status).toBe(0);
      writeFileSync(path.join(profile(bot), "login"), bot);
    }
    writeFileSync(path.join(runtime, "control-token"), "user-control");
    expect(
      run(
        checkpointScreensCommand([
          { screenId: "controller", index: 0 },
          { screenId: "viewer", index: 1 },
        ]),
      ).status,
    ).toBe(0);
    expect(readFileSync(path.join(shared, "login"), "utf8")).toBe("controller");
    expect(existsSync(profile("controller"))).toBe(false);
    expect(existsSync(profile("viewer"))).toBe(false);
  });

  it("retains the control fence until a successful checkpoint can be acknowledged", () => {
    const { runtime, run } = fixture();
    const tokenFile = path.join(runtime, "control-token");
    writeFileSync(tokenFile, "current-control");
    const revoke = `pkill() { return 0; }\ntimeout() { return 1; }\n${interactiveScreenCommand(false, "current-control")}`;
    expect(run(revoke).stdout).toContain("RAKAZO_CONTROL_RELEASED");
    expect(readFileSync(tokenFile, "utf8")).toBe("current-control");
    // A checkpoint failure can retry the same lease, but an old acknowledgement cannot clear a new lease.
    expect(run(revoke).stdout).toContain("RAKAZO_CONTROL_RELEASED");
    expect(run(completeControlReleaseCommand(0, "old-control")).status).toBe(0);
    expect(readFileSync(tokenFile, "utf8")).toBe("current-control");
    expect(run(completeControlReleaseCommand(0, "current-control")).status).toBe(0);
    expect(existsSync(tokenFile)).toBe(false);
  });

  it("preserves interrupted sign-ins when the same bot restarts", () => {
    const { shared, profile, run } = fixture();
    writeFileSync(path.join(shared, "login"), "initial-session");
    writeFileSync(path.join(shared, ".rakazo-generation"), "4");
    expect(run(prepareBrowserProfileCommand("writer")).status).toBe(0);
    writeFileSync(path.join(profile("writer"), "login"), "new-sign-in");
    writeFileSync(path.join(shared, "login"), "another-bot-session");
    writeFileSync(path.join(shared, ".rakazo-generation"), "5");

    expect(run(prepareBrowserProfileCommand("writer")).status).toBe(0);
    expect(readFileSync(path.join(profile("writer"), "login"), "utf8")).toBe("new-sign-in");
    expect(readFileSync(path.join(profile("writer"), ".rakazo-base-generation"), "utf8")).toBe(
      "4\n",
    );
  });

  it("does not publish a partial profile when seeding fails", () => {
    const { shared, profile, run } = fixture();
    writeFileSync(path.join(shared, "login"), "shared-session");
    const failed = run(`cp() { return 1; }\n${prepareBrowserProfileCommand("writer")}`);
    expect(failed.status).not.toBe(0);
    expect(existsSync(profile("writer"))).toBe(false);
    expect(run(prepareBrowserProfileCommand("writer")).status).toBe(0);
    expect(readFileSync(path.join(profile("writer"), "login"), "utf8")).toBe("shared-session");
  });

  it("keeps concurrent checkpoints fenced and permits explicit user promotion", () => {
    const { shared, profile, run } = fixture();
    for (const bot of ["writer", "researcher", "controller"]) {
      expect(run(prepareBrowserProfileCommand(bot)).status).toBe(0);
      writeFileSync(path.join(profile(bot), "login"), bot);
    }
    expect(run(syncSharedBrowserProfileCommand("writer")).status).toBe(0);
    expect(run(syncSharedBrowserProfileCommand("researcher")).status).toBe(0);
    expect(readFileSync(path.join(shared, "login"), "utf8")).toBe("writer");
    expect(run(syncSharedBrowserProfileCommand("controller", true)).status).toBe(0);
    expect(readFileSync(path.join(shared, "login"), "utf8")).toBe("controller");
    expect(run(prepareBrowserProfileCommand("new-bot")).status).toBe(0);
    expect(readFileSync(path.join(profile("new-bot"), "login"), "utf8")).toBe("controller");
  });
});
