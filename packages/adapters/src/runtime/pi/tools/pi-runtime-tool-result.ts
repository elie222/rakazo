import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { DEFAULT_CONTEXT_STRATEGY } from "@rakazo/adapter-kit";
import { isVerbatimMcpResult } from "../../../mcp/verbatim-mcp-result.js";
import { shortenToolResultText } from "../../context/context-selection.js";
import { VERBATIM_TOOL_RESULTS } from "../../context/runtime-context.js";
import {
  clipToolResultContent,
  clipToolResultText,
  TOOL_RESULT_TEXT_LIMIT,
} from "../pi-runtime-limits.js";

export function keepToolResultWhole(
  name: string,
  args: Record<string, unknown>,
  verbatimMcpServers?: AgentRunRequest["verbatimMcpServers"],
): boolean {
  return VERBATIM_TOOL_RESULTS.has(name) || isVerbatimMcpResult(name, args, verbatimMcpServers);
}

export function serializeToolResult(
  result: unknown,
  strategy: AgentRunRequest["contextStrategy"],
  name: string,
  args: Record<string, unknown>,
  verbatimMcpServers?: AgentRunRequest["verbatimMcpServers"],
) {
  try {
    const text = JSON.stringify(result);
    if (!text) return "ok";
    // skill-tools.ts already bounds skill content; the context budget selector may still shorten it.
    if (
      text.length <= TOOL_RESULT_TEXT_LIMIT ||
      keepToolResultWhole(name, args, verbatimMcpServers)
    )
      return text;
    return (strategy ?? DEFAULT_CONTEXT_STRATEGY) === "current"
      ? clipToolResultText(text)
      : shortenToolResultText(text, TOOL_RESULT_TEXT_LIMIT, { name, arguments: args });
  } catch {
    return "ok";
  }
}

/** Exact text Pi delivers to the model for a JSON tool result after result bounding. */
export function deliveredToolResultText(
  result: unknown,
  strategy: AgentRunRequest["contextStrategy"],
  name: string,
  args: Record<string, unknown>,
  verbatimMcpServers?: AgentRunRequest["verbatimMcpServers"],
): string {
  const text = serializeToolResult(result, strategy, name, args, verbatimMcpServers);
  return keepToolResultWhole(name, args, verbatimMcpServers) ? text : clipToolResultText(text);
}

export function boundAgentToolResult<T>(result: AgentToolResult<T>): AgentToolResult<T> {
  if (!result || !Array.isArray(result.content)) return result;
  return {
    ...result,
    content: clipToolResultContent(result.content),
  };
}
