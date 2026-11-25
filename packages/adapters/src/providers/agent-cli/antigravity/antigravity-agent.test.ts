import { lstatSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostCredentialSource, resolveDeploymentModel } from "../../../models/deployment-model.js";
import { antigravityAgent } from "./antigravity-agent.js";
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
  });

  it("starts the CLI with a home of its own that links only the operator's sign-in", async () => {
    operatorHome = mkdtempSync(join(tmpdir(), "rakazo-antigravity-test-"));
    // The CLI's home lives in the temp folder; this test gets one of its own.
    vi.stubEnv("TMPDIR", operatorHome);
    const env = { PATH: "/usr/bin", HOME: operatorHome };

    const launch = await antigravityAgent.launch({
      files: operatorHome,
      instructions: "You are Pip.",
      toolServer: "rakazo",
      env,
    });
    // A second turn reuses the same home and links.
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
});
