import type { AgentRuntime } from "@rakazo/adapter-kit";
import {
  CLAUDE_CODE_PROVIDER_ID,
  registerClaudeCodeProvider,
} from "../providers/cli-model/claude-code/provider.js";
import { createRuntimeModels } from "../runtime/pi/pi-runtime-models.js";
import { withRuntimeModels } from "../runtime/pi/pi-runtime-scope.js";
import type { PersonalCliAccessCheck } from "./personal-access.js";

/**
 * Runs a runtime's calls to `provider` through a person's own signed-in CLI, or undefined when it
 * is not such a provider. Usage counts against that person's plan, so its cost is unknown, not $0.
 */
export function personalCliRuntime(
  provider: string,
  modelId: string,
  accessCheck: PersonalCliAccessCheck,
): ((runtime: AgentRuntime) => AgentRuntime) | undefined {
  if (provider !== CLAUDE_CODE_PROVIDER_ID) return undefined;
  const models = registerClaudeCodeProvider(createRuntimeModels(), { modelId, accessCheck });
  return (runtime) => withRuntimeModels(runtime, models);
}
