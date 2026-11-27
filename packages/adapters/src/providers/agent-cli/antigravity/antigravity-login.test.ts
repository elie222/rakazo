import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAntigravityCliLogin } from "./antigravity-login.js";
import { antigravityProfileDir } from "./antigravity-profiles.js";
import { ANTIGRAVITY_CLI_PROVIDER_ID } from "./provider-id.js";

let workDir: string;
let fakeCli: string;
let logFile: string;

function writeFakeCli(script: string): string {
  const path = join(workDir, "fake-agy.mjs");
  writeFileSync(path, `#!/usr/bin/env node\n${script}`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "rakazo-agy-login-test-"));
  logFile = join(workDir, "login.json");
  fakeCli = writeFakeCli(`
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { createInterface } from "node:readline";
    const args = process.argv.slice(2);
    const geminiDirIdx = args.indexOf("--gemini-dir");
    const appDataIdx = args.indexOf("--app-data-dir");
    if (args[0] !== "acp" || geminiDirIdx === -1 || appDataIdx === -1 || !args.includes("--login")) {
      console.error("unexpected args", args);
      process.exit(2);
    }
    const geminiDir = args[geminiDirIdx + 1];
    const appDataDir = args[appDataIdx + 1];
    console.log("Please open this URL in your browser:");
    console.log("https://accounts.google.com/o/oauth2/auth?client_id=test&state=abc123");
    const rl = createInterface({ input: process.stdin });
    rl.once("line", (line) => {
      writeFileSync(${JSON.stringify(logFile)}, JSON.stringify({
        code: line,
        args,
        geminiDir,
        appDataDir,
        geminiHome: process.env.GEMINI_HOME,
        xdgConfigHome: process.env.XDG_CONFIG_HOME,
        dbus: process.env.DBUS_SESSION_BUS_ADDRESS ?? null,
        browser: process.env.BROWSER,
      }));
      if (line.includes("bad-code")) {
        console.error("invalid_grant");
        process.exit(1);
      }
      const logDir = join(geminiDir, appDataDir, "log");
      mkdirSync(logDir, { recursive: true });
      writeFileSync(
        join(logDir, "acp-login-20261127_152002-1.log"),
        "I1127 15:20:16.585253 114 server_oauth.go:226] OAuth: authenticated successfully as founder@example.com\\n",
      );
      console.log("Login succeeded!");
      process.exit(0);
    });
  `);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("createAntigravityCliLogin", () => {
  it("emits the Google auth URL, pipes the pasted code to agy, and stores only the profile marker", async () => {
    const profileId = randomUUID();
    const env = { PATH: process.env.PATH, DATA_DIR: workDir };
    const login = createAntigravityCliLogin({
      command: fakeCli,
      env,
      createProfileId: () => profileId,
    });
    const events: unknown[] = [];
    const interaction: AuthInteraction = {
      notify(event) {
        events.push(event);
      },
      async prompt() {
        return "  https://antigravity.google/oauth-callback?code=4/test-code&state=abc123  ";
      },
    };

    const credential = await login(interaction);

    expect(events).toEqual([
      expect.objectContaining({
        type: "auth_url",
        url: "https://accounts.google.com/o/oauth2/auth?client_id=test&state=abc123",
      }),
    ]);
    expect(credential).toEqual({
      type: "oauth",
      access: `${ANTIGRAVITY_CLI_PROVIDER_ID}:${profileId}`,
      refresh: `${ANTIGRAVITY_CLI_PROVIDER_ID}:${profileId}`,
      expires: Number.MAX_SAFE_INTEGER,
      accountId: profileId,
      email: "founder@example.com",
    });
    const recorded = JSON.parse(readFileSync(logFile, "utf8")) as {
      code: string;
      args: string[];
      geminiDir: string;
      appDataDir: string;
      geminiHome: string;
      xdgConfigHome: string;
      dbus: string | null;
      browser: string;
    };
    const expectedDir = antigravityProfileDir(profileId, env);
    expect(recorded.code).toBe(
      "https://antigravity.google/oauth-callback?code=4/test-code&state=abc123",
    );
    expect(recorded.geminiDir).toBe(expectedDir);
    expect(recorded.appDataDir).toBe("acp");
    expect(recorded.geminiHome).toBe(expectedDir);
    expect(recorded.xdgConfigHome).toBe(join(expectedDir, "config"));
    expect(recorded.dbus).toBe(process.platform === "linux" ? "disabled:" : null);
    expect(recorded.browser).toBe("true");
    expect(existsSync(expectedDir)).toBe(true);
  });

  it("removes the profile folder if agy exits with a non-zero status", async () => {
    const profileId = randomUUID();
    const env = { PATH: process.env.PATH, DATA_DIR: workDir };
    const login = createAntigravityCliLogin({
      command: fakeCli,
      env,
      createProfileId: () => profileId,
    });

    await expect(
      login({
        notify() {},
        async prompt() {
          return "bad-code";
        },
      }),
    ).rejects.toThrow("invalid_grant");
    expect(existsSync(antigravityProfileDir(profileId, env))).toBe(false);
  });

  it("removes the profile folder when cancelled while waiting for the code", async () => {
    const profileId = randomUUID();
    const env = { PATH: process.env.PATH, DATA_DIR: workDir };
    const login = createAntigravityCliLogin({
      command: fakeCli,
      env,
      createProfileId: () => profileId,
    });
    const controller = new AbortController();

    await expect(
      login({
        signal: controller.signal,
        notify() {},
        async prompt() {
          controller.abort(new Error("cancelled by user"));
          throw new Error("cancelled by user");
        },
      }),
    ).rejects.toThrow("cancelled by user");
    expect(existsSync(antigravityProfileDir(profileId, env))).toBe(false);
  });

  it("rejects multiline input and cleans up the profile folder", async () => {
    const profileId = randomUUID();
    const env = { PATH: process.env.PATH, DATA_DIR: workDir };
    const login = createAntigravityCliLogin({
      command: fakeCli,
      env,
      createProfileId: () => profileId,
    });

    await expect(
      login({
        notify() {},
        async prompt() {
          return "line1\nline2";
        },
      }),
    ).rejects.toThrow("single line");
    expect(existsSync(antigravityProfileDir(profileId, env))).toBe(false);
  });

  it("reports a clear installation error when agy is missing", async () => {
    const profileId = randomUUID();
    const env = { PATH: process.env.PATH, DATA_DIR: workDir };
    const login = createAntigravityCliLogin({
      command: join(workDir, "nonexistent-agy"),
      env,
      createProfileId: () => profileId,
    });

    await expect(
      login({
        notify() {},
        async prompt() {
          return "unused";
        },
      }),
    ).rejects.toThrow("Antigravity CLI (`agy`) is not installed");
    expect(existsSync(antigravityProfileDir(profileId, env))).toBe(false);
  });
});
