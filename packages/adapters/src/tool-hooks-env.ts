import { readFileSync } from "node:fs";
import { createToolHookRunner, type ToolHookRunner, toolHooksFromEnv } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";

/**
 * Builds the tool-hook runner a process starts with, from RAKAZO_TOOL_HOOKS or
 * RAKAZO_TOOL_HOOKS_FILE. Throws on a bad config so a typo fails the boot instead of silently
 * leaving a safety check off. Logs the hook, tool and decision, never the arguments or results.
 */
export function toolHookRunnerFromEnv(
  env: Record<string, string | undefined>,
): ToolHookRunner | undefined {
  const configs = toolHooksFromEnv(env, (path) => readFileSync(path, "utf8"));
  if (configs.length > 0)
    getLogger().info("tool.hooks.enabled", { hooks: configs.map((c) => c.name) });
  return createToolHookRunner(configs, {
    onVerdict: ({ phase, call, verdict }) =>
      getLogger().warn("tool.hook.verdict", {
        phase,
        hook: verdict.hook,
        tool: call.tool,
        decision: verdict.decision,
        failed: verdict.failed === true,
        reason: verdict.reason,
        runId: call.run.id,
        botId: call.run.botId,
      }),
  });
}
