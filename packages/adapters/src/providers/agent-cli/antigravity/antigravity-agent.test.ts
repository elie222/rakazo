import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostCredentialSource, resolveDeploymentModel } from "../../../models/deployment-model.js";
import { applyCodexLiveCatalog } from "../../../runtime/pi/models/pi-codex-catalog.js";
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
    const withTools = antigravityAgent.sessionMeta?.({
      instructions: "You are Pip.",
      toolServer: "rakazo",
    }) as {
      antigravity: {
        enabledTools: string[];
        eagerMcpServers: string[];
        systemPrompt: { append: string };
      };
    };
    expect(withTools.antigravity.enabledTools).toEqual([]);
    expect(withTools.antigravity.eagerMcpServers).toEqual(["rakazo"]);
    expect(withTools.antigravity.systemPrompt.append).toContain("You are Pip.");
    expect(withTools.antigravity.systemPrompt.append).toContain("mcp_rakazo_read_file");
    expect(withTools.antigravity.systemPrompt.append).toContain("Never call unprefixed CLI");

    // A turn without tools has no tool server for the CLI to load.
    const withoutTools = antigravityAgent.sessionMeta?.({ instructions: "You are Pip." }) as {
      antigravity: {
        enabledTools: string[];
        eagerMcpServers: string[];
        systemPrompt: { append: string };
      };
    };
    expect(withoutTools.antigravity.eagerMcpServers).toEqual([]);
    expect(withoutTools.antigravity.systemPrompt.append).toContain("No tools are enabled");
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

  it("uses an isolated per-account directory, flags, and env when profileId is provided", async () => {
    operatorHome = mkdtempSync(join(tmpdir(), "rakazo-antigravity-profile-"));
    const profileA = randomUUID();
    const profileB = randomUUID();
    const env = {
      PATH: "/usr/bin",
      HOME: operatorHome,
      DATA_DIR: operatorHome,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      GNOME_KEYRING_CONTROL: "/run/user/1000/keyring",
      XDG_RUNTIME_DIR: "/run/user/1000",
    };

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

    const dirA = join(operatorHome, "antigravity-profiles", profileA);
    const dirB = join(operatorHome, "antigravity-profiles", profileB);
    expect(launchA.args).toEqual(["acp", "--gemini-dir", dirA, "--app-data-dir", "acp"]);
    expect(launchB.args).toEqual(["acp", "--gemini-dir", dirB, "--app-data-dir", "acp"]);
    expect(launchA.env.GEMINI_HOME).toBe(dirA);
    expect(launchB.env.GEMINI_HOME).toBe(dirB);
    expect(launchA.env.XDG_CONFIG_HOME).toBe(join(dirA, "config"));
    expect(launchB.env.XDG_CONFIG_HOME).toBe(join(dirB, "config"));
    expect(launchA.env.DBUS_SESSION_BUS_ADDRESS).toBe(
      process.platform === "linux" ? "disabled:" : undefined,
    );
    expect(launchA.env.GNOME_KEYRING_CONTROL).toBeUndefined();
    expect(launchA.env.XDG_RUNTIME_DIR).toBeUndefined();
    expect(existsSync(dirA)).toBe(true);
    expect(existsSync(dirB)).toBe(true);
    expect(antigravityAgent.supportsThinking).toBe(true);
    expect(antigravityAgent.toolCallName("rakazo", "connectors_search_tools")).toBe(
      "mcp_rakazo_connectors_search_tools",
    );

    // Regression: `acp-runtime` passes scrubbed `cliEnv(process.env)` without `DATA_DIR`;
    // `launch` must still resolve the profile folder under `process.env.DATA_DIR` without leaking
    // `DATA_DIR` into the spawned CLI environment.
    vi.stubEnv("DATA_DIR", operatorHome);
    const scrubbedLaunch = await antigravityAgent.launch({
      files: operatorHome,
      instructions: "You are Pip.",
      toolServer: "rakazo",
      env: { PATH: "/usr/bin", HOME: operatorHome },
      profileId: profileB,
    });
    expect(scrubbedLaunch.env.GEMINI_HOME).toBe(dirB);
    expect(scrubbedLaunch.env.DATA_DIR).toBeUndefined();

    await removeAntigravityProfileDir(profileA, env);
    expect(existsSync(dirA)).toBe(false);
    expect(existsSync(dirB)).toBe(true);
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

    // Regression: listPiCatalog() must return stable entry references so overlayLiveCatalog
    // (used when a user also has a live ChatGPT/Codex subscription connected) keeps Antigravity.
    const first = listPiCatalog();
    const codexIds = first
      .filter((entry) => entry.provider === "openai-codex")
      .map((entry) => ({
        slug: entry.id,
        contextWindow: 128_000,
        reasoningEfforts: ["low", "high"],
        supportsImages: true,
        supportsFastTier: false,
      }));
    const merged = applyCodexLiveCatalog(
      first,
      {
        byProvider: { "openai-codex": "oauth" },
        byModel: {},
        secretIdByProvider: { "openai-codex": "sec-1" },
        secretIdByModel: {},
      },
      new Map([["sec-1", codexIds]]),
    );
    expect(merged.some((entry) => entry.provider === ANTIGRAVITY_CLI_PROVIDER_ID)).toBe(true);
  });
});
