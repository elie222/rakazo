import type { AgentRuntime } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { antigravityAgent } from "../providers/agent-cli/antigravity/antigravity-agent.js";
import { antigravityCliEnabled } from "../providers/agent-cli/antigravity/antigravity-profiles.js";
import { ANTIGRAVITY_CLI_PROVIDER_ID } from "../providers/agent-cli/antigravity/provider-id.js";
import type { RunRuntimeEnv } from "../runs/assembly/run-runtime.js";
import { acpAgentRuntime } from "../runtime/acp/acp-runtime.js";
import { personalCliAccessCheck } from "./personal-access.js";
import { personalCliRuntime } from "./personal-cli-runtime.js";

export function cliModelRuntime(
  env: Pick<RunRuntimeEnv, "defaultProvider" | "defaultModel" | "deploymentModelConfigured">,
  runtime: AgentRuntime,
  deps: { prisma: PrismaClient; billingEnabled?: boolean },
): AgentRuntime {
  const accessCheck = personalCliAccessCheck(deps);
  let next = runtime;
  let wrappedAntigravity = false;
  if (env.deploymentModelConfigured) {
    const throughCli = personalCliRuntime(env.defaultProvider, env.defaultModel, accessCheck);
    if (throughCli) {
      next = throughCli(next);
      if (env.defaultProvider === ANTIGRAVITY_CLI_PROVIDER_ID) wrappedAntigravity = true;
    }
  }
  if (!wrappedAntigravity && antigravityCliEnabled()) {
    next = acpAgentRuntime(next, antigravityAgent, { accessCheck });
  }
  return next;
}
