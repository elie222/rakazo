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
    import { writeFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    if (process.argv[2] !== "acp" || process.argv[3] !== "--login") {
      console.error("unexpected args", process.argv.slice(2));
      process.exit(2);
    }
    console.log("Please open this URL in your browser:");
    console.log("https://accounts.google.com/o/oauth2/auth?client_id=test&state=abc123");
    const rl = createInterface({ input: process.stdin });
    rl.once("line", (line) => {
      writeFileSync(${JSON.stringify(logFile)}, JSON.stringify({
        code: line,
        geminiHome: process.env.GEMINI_HOME,
        browser: process.env.BROWSER,
      }));
      if (line.includes("bad-code")) {
        console.error("invalid_grant");
        process.exit(1);
      }
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
    });
    const recorded = JSON.parse(readFileSync(logFile, "utf8")) as {
      code: string;
      geminiHome: string;
      browser: string;
    };
    expect(recorded.code).toBe(
      "https://antigravity.google/oauth-callback?code=4/test-code&state=abc123",
    );
    expect(recorded.geminiHome).toBe(antigravityProfileDir(profileId, env));
    expect(recorded.browser).toBe("true");
    expect(existsSync(antigravityProfileDir(profileId, env))).toBe(true);
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
