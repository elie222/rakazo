import type { AgentRuntime } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { RunRuntimeEnv } from "../runs/assembly/run-runtime.js";
import { personalCliAccessCheck } from "./personal-access.js";
import { personalCliRuntime } from "./personal-cli-runtime.js";

export function cliModelRuntime(
  env: Pick<RunRuntimeEnv, "defaultProvider" | "defaultModel" | "deploymentModelConfigured">,
  runtime: AgentRuntime,
  deps: { prisma: PrismaClient; billingEnabled?: boolean },
): AgentRuntime {
  if (!env.deploymentModelConfigured) return runtime;
  const throughCli = personalCliRuntime(
    env.defaultProvider,
    env.defaultModel,
    personalCliAccessCheck(deps),
  );
  return throughCli ? throughCli(runtime) : runtime;
}
