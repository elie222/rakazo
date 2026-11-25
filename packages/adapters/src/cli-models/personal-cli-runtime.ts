import type { AgentRuntime } from "@rakazo/adapter-kit";
import { openCodeAgent } from "../providers/agent-cli/opencode/opencode-agent.js";
import {
  CLAUDE_CODE_PROVIDER_ID,
  registerClaudeCodeProvider,
} from "../providers/cli-model/claude-code/provider.js";
import { acpAgentRuntime } from "../runtime/acp/acp-runtime.js";
import { createRuntimeModels } from "../runtime/pi/pi-runtime-models.js";
import { withRuntimeModels } from "../runtime/pi/pi-runtime-scope.js";
import type { PersonalCliAccessCheck } from "./personal-access.js";

type PersonalCliRoute = (
  modelId: string,
  accessCheck: PersonalCliAccessCheck,
) => (runtime: AgentRuntime) => AgentRuntime;

/**
 * How each signed-in CLI runs a deployment model: one that only answers as the model inside
 * Rakazo's own loop, or an agent CLI that runs the bot's loop itself over the Agent Client Protocol.
 */
const routes: Record<string, PersonalCliRoute> = {
  [CLAUDE_CODE_PROVIDER_ID]: (modelId, accessCheck) => {
    const models = registerClaudeCodeProvider(createRuntimeModels(), { modelId, accessCheck });
    return (runtime) => withRuntimeModels(runtime, models);
  },
  [openCodeAgent.id]: (_modelId, accessCheck) => (runtime) =>
    acpAgentRuntime(runtime, openCodeAgent, { accessCheck }),
};

/**
 * Runs a runtime's calls to `provider` through a person's own signed-in CLI, or undefined when it
 * is not such a provider. Usage counts against that person's plan, so its cost is unknown, not $0.
 */
export function personalCliRuntime(
  provider: string,
  modelId: string,
  accessCheck: PersonalCliAccessCheck,
): ((runtime: AgentRuntime) => AgentRuntime) | undefined {
  return Object.hasOwn(routes, provider) ? routes[provider]!(modelId, accessCheck) : undefined;
}
