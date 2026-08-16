import type { ConnectorTool } from "@rakazo/adapter-kit";

export const DELEGATION_TOOL_NAMES = new Set(["run_subagent", "spawn_bot", "delete_bot"]);

export const builtinAgentTools: ConnectorTool[] = [
  {
    name: "computer_observe",
    description:
      "Capture the current screen of this bot's computer. Returns frame metadata and an image. Observe before coordinate-based actions and whenever another actor may have changed the desktop.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "computer_act",
    description:
      "Perform up to 24 ordered desktop actions on this bot's computer and return the resulting screen. Batch only predictable actions; stop before an outcome you need to inspect. Action kinds: click, move, down, up, type, key, scroll, wait.",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["click", "move", "down", "up", "type", "key", "scroll", "wait"],
              },
              x: { type: "number" },
              y: { type: "number" },
              button: { type: "string", enum: ["left", "right"] },
              double: { type: "boolean" },
              text: { type: "string" },
              key: { type: "string" },
              modifiers: { type: "array", items: { type: "string" } },
              direction: { type: "string", enum: ["up", "down"] },
              amount: { type: "number" },
              ms: { type: "number" },
            },
            required: ["kind"],
          },
        },
        observe: { type: "boolean" },
        settle_ms: { type: "number" },
      },
      required: ["actions"],
    },
  },
  {
    name: "list_files",
    description:
      "List files and directories in this bot's home. On a Team Computer, relative paths use the bot folder; use shared/... for shared work or bots/... to inspect the Team root.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
    },
  },
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file from this bot's home. On a Team Computer, relative paths use the bot folder and shared/... accesses shared work. Open visual or binary files with open_path instead.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write a UTF-8 file into this bot's home. On a Team Computer, relative paths use the bot folder; use shared/... only for work other bots should share.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "shell",
    description:
      "Run a command inside this bot's computer. cwd defaults to the bot's folder on a Team Computer and the workspace root on a Private Computer.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["command"],
    },
  },
  {
    name: "open_path",
    description:
      "Open a workspace file or an http(s) URL in its default graphical application on this bot's computer and return the resulting screen.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "launch_app",
    description:
      "Launch an installed graphical application on this bot's computer, optionally with a URI, and return the resulting screen.",
    inputSchema: {
      type: "object",
      properties: {
        application: { type: "string" },
        uri: { type: "string" },
      },
      required: ["application"],
    },
  },
  {
    name: "request_takeover",
    description:
      "Ask the user to take over the computer screen for login or human judgment. Protected input stays off the thread.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
  {
    name: "remember",
    description: "Store a durable fact in this bot's explicit memory.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        path: { type: "string" },
      },
      required: ["content"],
    },
  },
  {
    name: "run_subagent",
    description:
      "Run a short-lived helper inside this turn only. It is not a bot: no list entry, no thread, no computer of its own, and it disappears when this turn ends. Never call this because the user asked to create a bot — that is spawn_bot, and spawn_bot alone.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short label shown in the thread, e.g. scout or reviewer.",
        },
        task: { type: "string", description: "The work the helper should complete." },
        instructions: {
          type: "string",
          description: "Optional extra system instructions for the helper.",
        },
      },
      required: ["name", "task"],
    },
  },
  {
    name: "spawn_bot",
    description:
      "Create a full, regular bot — the same kind the user creates from the + button. It gets its own thread, computer, and memory, and appears as a peer in the bot list. Do not also call run_subagent. Creating the bot is the whole action. Only set prompt if the user asked that new bot to start work immediately.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        title: { type: "string" },
        instructions: { type: "string" },
        prompt: {
          type: "string",
          description: "Optional first task to run in the new bot's thread.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_bot",
    description:
      "Permanently delete a bot this bot created, including its thread, computer, memory, and files. Only do this when the user asked or that bot is finished and unused. confirm_name must exactly match its name. This cannot delete you, bots the user created, or bots another bot created.",
    inputSchema: {
      type: "object",
      properties: {
        confirm_name: { type: "string", description: "Exact current name of the bot to delete." },
        bot_id: {
          type: "string",
          description:
            "Optional bot id. If omitted, the unique bot this bot created with confirm_name is deleted.",
        },
      },
      required: ["confirm_name"],
    },
  },
];
