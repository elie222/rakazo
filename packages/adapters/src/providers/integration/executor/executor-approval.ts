import type { ConnectorTool } from "@rakazo/adapter-kit";
import { ConnectionToolPath } from "@rakazo/contracts";
import * as z from "zod";

const describedTools = z.object({
  items: z.array(z.object({ path: ConnectionToolPath })),
  missing: z.array(z.unknown()).length(0),
});
const describeResponse = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).optional(),
});
const DESCRIBE_PATH_LIMIT = 20;

export function executorApprovalFields(
  peer: string | undefined,
  tool: { name: string; inputSchema: { properties?: Record<string, unknown> } },
  connection: { id: string; name: string },
  lookup: (
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<{ result: unknown; binding: object } | undefined>,
): Pick<ConnectorTool, "batch" | "readOnly"> {
  if (
    peer?.toLowerCase() !== "executor" ||
    tool.name !== "call" ||
    !Object.hasOwn(tool.inputSchema.properties ?? {}, "calls")
  ) {
    return {};
  }
  return {
    readOnly: false,
    batch: {
      items: "calls",
      action: "path",
      arguments: "input",
      acceptsSingle: true,
      approvalScope: {
        connectionId: connection.id,
        connectionName: connection.name,
        resolve: async (paths, signal) => {
          if (!paths.every((path) => ConnectionToolPath.safeParse(path).success)) return undefined;
          let binding: object | undefined;
          for (let start = 0; start < paths.length; start += DESCRIBE_PATH_LIMIT) {
            const group = paths.slice(start, start + DESCRIBE_PATH_LIMIT);
            const lookupResult = await lookup("describe", { paths: group }, signal);
            if (!lookupResult || (binding && binding !== lookupResult.binding)) return undefined;
            binding = lookupResult.binding;
            const response = describeResponse.safeParse(lookupResult.result);
            if (!response.success || response.data.isError) return undefined;
            const { structuredContent, content } = response.data;
            const result = describedTools.safeParse(structuredContent ?? parseTextResult(content));
            if (!result.success) return undefined;
            const found = new Set(result.data.items.map((item) => item.path));
            if (found.size !== group.length || !group.every((path) => found.has(path)))
              return undefined;
          }
          return binding;
        },
      },
    },
  };
}

function parseTextResult(content: Array<{ text: string }> | undefined): unknown {
  if (content?.length !== 1) return undefined;
  try {
    return JSON.parse(content[0]!.text);
  } catch {
    return undefined;
  }
}
