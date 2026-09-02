import type { ConnectorTool } from "@rakazo/adapter-kit";

export const HOST_DISK_TOOL_NAMES = new Set([
  "list_host_files",
  "read_host_file",
  "write_host_file",
  "copy_to_host",
  "copy_from_host",
]);

/**
 * Optional tools for the user's Mac/phone disk. Kept out of builtinAgentTools so
 * they stay deny-by-default until opt-in + a connected client.
 */
export const hostDiskTools: ConnectorTool[] = [
  {
    name: "list_host_files",
    description:
      "List files and folders on the user's own computer (the Mac or phone app), inside folders they granted. Not the bot sandbox disk.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path under a granted folder, or empty for the granted roots.",
        },
      },
    },
    readOnly: true,
  },
  {
    name: "read_host_file",
    description:
      "Read a UTF-8 text file from the user's own computer inside a granted folder. Not the bot sandbox disk.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path under a granted folder." },
      },
      required: ["path"],
    },
    readOnly: true,
  },
  {
    name: "write_host_file",
    description:
      "Write a UTF-8 text file on the user's own computer inside a granted folder. Not the bot sandbox disk.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path under a granted folder." },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "copy_to_host",
    description:
      "Copy a file from this bot's computer into a granted folder on the user's own computer.",
    inputSchema: {
      type: "object",
      properties: {
        bot_path: {
          type: "string",
          description: "Path inside the bot computer workspace.",
        },
        host_path: {
          type: "string",
          description: "Absolute destination path under a granted folder.",
        },
      },
      required: ["bot_path", "host_path"],
    },
  },
  {
    name: "copy_from_host",
    description:
      "Copy a file from a granted folder on the user's own computer into this bot's computer.",
    inputSchema: {
      type: "object",
      properties: {
        host_path: {
          type: "string",
          description: "Absolute source path under a granted folder.",
        },
        bot_path: {
          type: "string",
          description: "Destination path inside the bot computer workspace.",
        },
      },
      required: ["host_path", "bot_path"],
    },
  },
];

/** Deny by default: empty until opt-in + a connected client makes access available. */
export function selectHostDiskTools(hostDiskAccessEnabled: boolean): ConnectorTool[] {
  return hostDiskAccessEnabled ? hostDiskTools : [];
}
