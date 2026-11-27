import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostCredentialSource, resolveDeploymentModel } from "../../../models/deployment-model.js";
import { listPiCatalog } from "../../../runtime/pi/models/pi-models.js";
import { antigravityAgent } from "./antigravity-agent.js";
import {
  antigravityCliEnabled,
  isAntigravityProfileId,
  removeAntigravityProfileDir,
} from "./antigravity-profiles.js";
import { ANTIGRAVITY_CLI_PROVIDER_ID } from "./provider-id.js";

let operatorHome: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (operatorHome) rmSync(operatorHome, { recursive: true, force: true });
  operatorHome = undefined;
});

describe("antigravityAgent", () => {
  it("turns off every built-in tool and adds Rakazo's instructions to each session", () => {
    expect(
      antigravityAgent.sessionMeta?.({ instructions: "You are Pip.", toolServer: "rakazo" }),
    ).toEqual({
      antigravity: {
        enabledTools: [],
        eagerMcpServers: ["rakazo"],
        systemPrompt: { append: "You are Pip." },
      },
    });
    // A turn without tools has no tool server for the CLI to load.
    expect(antigravityAgent.sessionMeta?.({ instructions: "You are Pip." })).toMatchObject({
      antigravity: { eagerMcpServers: [] },
    });
  });

  it("starts the CLI with a home of its own that links only the operator's sign-in", async () => {
    operatorHome = mkdtempSync(join(tmpdir(), "rakazo-antigravity-test-"));
    // The CLI's home lives in the temp folder; this test gets one of its own.
    vi.stubEnv("TMPDIR", operatorHome);
    vi.stubEnv("HOME", operatorHome);
    const env = { PATH: "/usr/bin", HOME: operatorHome };

    const launch = await antigravityAgent.launch({
      files: operatorHome,
      instructions: "You are Pip.",
      toolServer: "rakazo",
      env,
    });
    // A sign-in the CLI wrote over a link is replaced by the link again on the next turn.
    const own = join(launch.env.GEMINI_HOME!, "antigravity-acp");
    rmSync(join(own, "acp_token.json"));
    writeFileSync(join(own, "acp_token.json"), "{}");
    await antigravityAgent.launch({ files: operatorHome, instructions: "", toolServer: "", env });

    expect(launch.args).toEqual(["acp"]);
    const home = launch.env.GEMINI_HOME!;
    expect(home.startsWith(operatorHome)).toBe(true);
    expect(home).not.toBe(join(operatorHome, ".gemini"));
    for (const name of ["acp_token.json", "acp_business_token.json", "settings.json"]) {
      const link = join(home, "antigravity-acp", name);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link).endsWith(join(".gemini", "antigravity-acp", name))).toBe(true);
    }
  });

  it("is a deployment model the operator configures with the CLI's own sign-in", () => {
    const model = resolveDeploymentModel({
      PI_DEFAULT_PROVIDER: ANTIGRAVITY_CLI_PROVIDER_ID,
      PI_DEFAULT_CREDENTIALS: "host",
      PI_DEFAULT_MODEL: "gemini-model",
    });

    expect(model).toMatchObject({ configured: true, hostCredentials: true, key: undefined });
    expect(hostCredentialSource(ANTIGRAVITY_CLI_PROVIDER_ID)).toBe("CLI");
  });

  it("uses an isolated per-account GEMINI_HOME when profileId is provided", async () => {
    operatorHome = mkdtempSync(join(tmpdir(), "rakazo-antigravity-profile-"));
    const profileA = randomUUID();
    const profileB = randomUUID();
    const env = { PATH: "/usr/bin", HOME: operatorHome, DATA_DIR: operatorHome };

    const launchA = await antigravityAgent.launch({
      files: operatorHome,
      instructions: "You are Pip.",
      toolServer: "rakazo",
      env,
      profileId: profileA,
    });
    const launchB = await antigravityAgent.launch({
      files: operatorHome,
      instructions: "You are Pip.",
      toolServer: "rakazo",
      env,
      profileId: profileB,
    });

    expect(launchA.env.GEMINI_HOME).toBe(join(operatorHome, "antigravity-profiles", profileA));
    expect(launchB.env.GEMINI_HOME).toBe(join(operatorHome, "antigravity-profiles", profileB));
    expect(existsSync(launchA.env.GEMINI_HOME!)).toBe(true);
    expect(existsSync(launchB.env.GEMINI_HOME!)).toBe(true);
    expect(antigravityAgent.supportsThinking).toBe(true);

    await removeAntigravityProfileDir(profileA, env);
    expect(existsSync(launchA.env.GEMINI_HOME!)).toBe(false);
    expect(existsSync(launchB.env.GEMINI_HOME!)).toBe(true);
  });

  it("rejects non-UUID profile identifiers to prevent path traversal", () => {
    expect(isAntigravityProfileId(randomUUID())).toBe(true);
    expect(isAntigravityProfileId("../escape")).toBe(false);
    expect(isAntigravityProfileId("")).toBe(false);
  });

  it("exposes Antigravity models with thinking levels only when opted in", () => {
    vi.stubEnv("RAKAZO_ANTIGRAVITY_CLI", "");
    vi.stubEnv("PI_DEFAULT_PROVIDER", "");
    expect(antigravityCliEnabled()).toBe(false);
    expect(listPiCatalog().some((entry) => entry.provider === ANTIGRAVITY_CLI_PROVIDER_ID)).toBe(
      false,
    );

    vi.stubEnv("RAKAZO_ANTIGRAVITY_CLI", "true");
    expect(antigravityCliEnabled()).toBe(true);
    const entries = listPiCatalog().filter(
      (entry) => entry.provider === ANTIGRAVITY_CLI_PROVIDER_ID,
    );
    const neon = entries.find((entry) => entry.id === "gemini-4-neon");
    expect(neon).toMatchObject({
      provider: ANTIGRAVITY_CLI_PROVIDER_ID,
      providerName: "Antigravity",
      recommended: true,
      auth: "oauth",
      signIn: "auth-url",
      reasoning: true,
      thinkingLevels: ["low", "medium", "high", "xhigh"],
      images: true,
    });
  });
});
