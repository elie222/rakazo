import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostCredentialSource, resolveDeploymentModel } from "../../../models/deployment-model.js";
import { openCodeAgent } from "./opencode-agent.js";
import { OPENCODE_CLI_PROVIDER_ID } from "./provider-id.js";

let files: string | undefined;

afterEach(() => {
  if (files) rmSync(files, { recursive: true, force: true });
  files = undefined;
});

describe("openCodeAgent", () => {
  it("starts OpenCode with only the tool server allowed and Rakazo's instructions as its prompt", async () => {
    files = mkdtempSync(join(tmpdir(), "rakazo-opencode-test-"));

    const launch = await openCodeAgent.launch({
      files,
      instructions: "You are Pip.",
      toolServer: "rakazo",
      env: { PATH: "/usr/bin", HOME: "/home/operator" },
    });

    expect(launch.args).toEqual(["acp"]);
    expect(launch.env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/operator",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
    });
    // The operator's own config folder (plugins, MCP servers, instructions) is swapped for an
    // empty one; their sign-in lives elsewhere and is untouched.
    expect(readdirSync(launch.env.OPENCODE_CONFIG_DIR!)).toEqual([]);
    const config = JSON.parse(readFileSync(launch.env.OPENCODE_CONFIG!, "utf8"));
    const permission = { "*": "deny", "rakazo_*": "allow" };
    expect(config).toMatchObject({
      permission,
      default_agent: "rakazo",
      agent: { rakazo: { mode: "primary", prompt: "You are Pip.", permission } },
      plugins: ["-opencode.tool.skill"],
    });
  });

  it("reads a tool call's name from the title where older releases put it", () => {
    expect(
      openCodeAgent.reportedToolName?.({ sessionUpdate: "tool_call", title: "rakazo_get_weather" }),
    ).toBe("rakazo_get_weather");
    expect(
      openCodeAgent.reportedToolName?.({ sessionUpdate: "tool_call_update", title: "Paris" }),
    ).toBeUndefined();
  });

  it("is a deployment model the operator configures with the CLI's own sign-in", () => {
    const model = resolveDeploymentModel({
      PI_DEFAULT_PROVIDER: OPENCODE_CLI_PROVIDER_ID,
      PI_DEFAULT_CREDENTIALS: "host",
      PI_DEFAULT_MODEL: "opencode/big-pickle",
    });

    expect(model).toMatchObject({ configured: true, hostCredentials: true, key: undefined });
    expect(hostCredentialSource(OPENCODE_CLI_PROVIDER_ID)).toBe("CLI");
  });
});
