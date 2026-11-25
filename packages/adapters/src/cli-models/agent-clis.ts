import type { Api, Model } from "@earendil-works/pi-ai";
import { antigravityAgent } from "../providers/agent-cli/antigravity/antigravity-agent.js";
import { openCodeAgent } from "../providers/agent-cli/opencode/opencode-agent.js";
import type { AcpAgentDescriptor } from "../runtime/acp/acp-agent.js";

/** The agent CLIs a deployment model can run on, each described by its own provider. */
const agentClis: readonly AcpAgentDescriptor[] = [openCodeAgent, antigravityAgent];

export function agentCli(provider: string): AcpAgentDescriptor | undefined {
  return agentClis.find((descriptor) => descriptor.id === provider);
}

/**
 * What the rest of Rakazo knows about a model an agent CLI runs: only whether it sees images,
 * which the CLI's descriptor says. The CLI keeps its own limits, and its plan pays, so no cost.
 */
export function agentCliModel(descriptor: AcpAgentDescriptor, id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "acp",
    provider: descriptor.id,
    baseUrl: "",
    reasoning: false,
    input: descriptor.acceptsImages ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  } as Model<Api>;
}
