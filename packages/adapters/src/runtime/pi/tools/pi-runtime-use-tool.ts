import type { AgentTool } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { providerToolCallId } from "../../../runs/turn/tool-call-ids.js";
import { USE_TOOL } from "../../../tools/builtin.tool-definition.js";
import { unavailableToolReason } from "../../../tools/builtin-tool-bridge.js";
import type { ToolHost } from "./pi-runtime-tools.js";

/**
 * Unwraps to the real tool before anything else, so its gate, approvals, checkpoint, audit
 * and activity all name that tool exactly as a direct call would.
 */
export function useToolAgentTool(
  wrapper: AgentTool,
  runnable: ReadonlyMap<string, AgentTool>,
  catalogRunners: ReadonlyMap<string, AgentTool>,
  host: ToolHost,
): AgentTool {
  return {
    ...wrapper,
    // Deferred schedule and memory tools must not race a sibling call.
    executionMode: "sequential",
    execute: async (toolCallId, params, signal, onUpdate) => {
      const { name, arguments: args } = params as { name: string; arguments?: unknown };
      const tool = runnable.get(name);
      const reason = tool
        ? undefined
        : unavailableToolReason(host.request.unavailableToolReasons, name);
      const connectorId = host.foundConnectorTools?.get(name);
      const runner = !tool && !reason && connectorId ? catalogRunners.get(connectorId) : undefined;
      if (runner) {
        const call = { id: name, arguments: args ?? {} };
        const validated = validateToolArguments(runner, {
          type: "toolCall",
          id: toolCallId,
          name: runner.name,
          arguments: call as never,
        });
        return runner.execute(toolCallId, validated, signal, onUpdate);
      }
      if (!tool) {
        host.queue.push({
          type: "tool",
          name: USE_TOOL,
          args: params as Record<string, unknown>,
          executionId: JSON.stringify([
            "pi-tool",
            host.agentNamespace ?? "main",
            providerToolCallId(host.providerToolCallIds, toolCallId),
          ]),
          response: host.modelResponses,
        });
        throw new Error(reason ?? `${name} is not available. Use a name find_tool lists.`);
      }
      const prepared = tool.prepareArguments?.(args ?? {}) ?? args ?? {};
      const validated = validateToolArguments(tool, {
        type: "toolCall",
        id: toolCallId,
        name,
        arguments: prepared as never,
      });
      return tool.execute(toolCallId, validated, signal, onUpdate);
    },
  };
}
