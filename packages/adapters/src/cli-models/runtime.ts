import type { AgentRuntime } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  CLAUDE_CODE_PROVIDER_ID,
  claudeCodeModelIds,
  registerClaudeCodeProvider,
} from "../providers/cli-model/claude-code/provider.js";
import type { RunRuntimeEnv } from "../runs/assembly/run-runtime.js";
import { createRuntimeModels } from "../runtime/pi/pi-runtime-models.js";
import { withRuntimeModels } from "../runtime/pi/pi-runtime-scope.js";
import { personalCliAccessCheck } from "./personal-access.js";

export function cliModelRuntime(
  env: Pick<RunRuntimeEnv, "defaultProvider" | "defaultModel" | "deploymentModelConfigured">,
  runtime: AgentRuntime,
  deps: { prisma: PrismaClient; billingEnabled?: boolean },
): AgentRuntime {
  if (env.defaultProvider !== CLAUDE_CODE_PROVIDER_ID || !env.deploymentModelConfigured) {
    return runtime;
  }
  const models = registerClaudeCodeProvider(createRuntimeModels(), {
    modelIds: claudeCodeModelIds(env.defaultModel),
    accessCheck: personalCliAccessCheck(deps),
  });
  return withRuntimeModels(runtime, models);
}
