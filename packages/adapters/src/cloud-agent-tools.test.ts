import type { AdapterContext, ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { EmulatorCloudAgentProvider } from "./cloud-agent-emulator.js";
import {
  cloudAgentCancelFromTool,
  cloudAgentLaunchFromTool,
  cloudAgentReplyFromTool,
  cloudAgentStatusFromTool,
} from "./cloud-agent-tools.js";
import { selectCloudAgentTools } from "./cloud-agent-tools-select.js";

const ctx: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "s",
  userId: "u",
  signal: new AbortController().signal,
};

function tool(name: string): ConnectorTool {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

describe("cloud agent tools", () => {
  it("hides cloud agent tools when the provider is unset", () => {
    const tools = [
      tool("web_search"),
      tool("cloud_agent_launch"),
      tool("cloud_agent_status"),
      tool("cloud_agent_reply"),
      tool("cloud_agent_cancel"),
    ];
    expect(selectCloudAgentTools(tools, false).map((entry) => entry.name)).toEqual(["web_search"]);
    expect(selectCloudAgentTools(tools, true).map((entry) => entry.name)).toEqual([
      "web_search",
      "cloud_agent_launch",
      "cloud_agent_status",
      "cloud_agent_reply",
      "cloud_agent_cancel",
    ]);
  });

  it("launch → status → reply → cancel on the emulator", async () => {
    const provider = new EmulatorCloudAgentProvider();
    const launched = await cloudAgentLaunchFromTool(provider, ctx, {
      prompt: "Ship a fix",
      repository: "https://github.com/example/demo",
      openPr: true,
    });
    expect(launched).toMatchObject({ status: "running" });
    expect("id" in launched && launched.id).toBeTruthy();

    const id = (launched as { id: string }).id;
    expect(await cloudAgentStatusFromTool(provider, ctx, { id })).toMatchObject({
      id,
      status: "running",
    });

    expect(
      await cloudAgentReplyFromTool(provider, ctx, {
        id,
        prompt: "Also update the changelog",
      }),
    ).toMatchObject({ id, status: "running" });

    provider.complete(id, {
      branch: "emulator/ship-a-fix",
      prUrl: "https://github.com/example/demo/pull/9",
    });
    expect(await cloudAgentStatusFromTool(provider, ctx, { id })).toMatchObject({
      status: "finished",
      branch: "emulator/ship-a-fix",
      prUrl: "https://github.com/example/demo/pull/9",
    });

    const other = await cloudAgentLaunchFromTool(provider, ctx, { prompt: "Stop me" });
    const otherId = (other as { id: string }).id;
    expect(await cloudAgentCancelFromTool(provider, ctx, { id: otherId })).toMatchObject({
      status: "cancelled",
    });
  });
});
