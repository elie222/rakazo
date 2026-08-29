import type { ConnectorTool } from "@rakazo/adapter-kit";

export const DELEGATION_TOOL_NAMES = new Set([
  "run_subagent",
  "spawn_bot",
  "archive_bot",
  "delete_bot",
  "handoff_to_bot",
  "message_bot",
]);

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
    name: "attach_file",
    description:
      "Attach a workspace file from this bot's home to the chat thread as an image or common file. The file stays in place; users can open it from the message.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
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
      "Ask the user to take over the computer screen for passwords, 2FA, CAPTCHA, payment, passkeys, or other protected input. Never ask the user to paste protected values in chat.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
  {
    name: "request_secret",
    description:
      "Collect a one-shot OTP, password, or API key in a masked field that never reaches the chat transcript or model. For website logins, CAPTCHA, passkeys, or anything that needs the live desktop, call request_takeover instead.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
        purpose: { type: "string", enum: ["otp", "password", "api_key"] },
        connectionId: { type: "string" },
      },
      required: ["label", "purpose"],
    },
  },
  {
    name: "render_plot",
    description:
      'Render a chart from tabular data as a PNG and attach it to the chat. Backed by Observable Plot: bar, line, area, scatter, histogram, heatmap, box plot, facets, and more via a declarative JSON spec. Call with {"charts": true} FIRST to list every chart type with a complete runnable example spec ({"charts": "<keyword>"} searches), then copy the closest example and substitute your rows and columns. {"help": true} returns the full guide. Pass rows inline as data, or data_path for a .csv/.tsv/.json file in your home.',
    inputSchema: {
      type: "object",
      properties: {
        charts: {
          description:
            'true lists all chart types with runnable example specs; a keyword string (e.g. "distribution", "share", "trend") searches them.',
        },
        help: {
          type: "boolean",
          description: "Return the full render_plot skill guide instead of rendering.",
        },
        spec: {
          type: "object",
          description:
            "Declarative Observable Plot spec: {title?, width?, height?, x?, y?, color?, fx?, fy?, marks: [{type, options, transform?, data?}]}.",
        },
        data: {
          type: "array",
          description: "Rows as objects, shared by marks without their own data.",
        },
        data_path: {
          type: "string",
          description:
            "Workspace path of a .csv, .tsv, or .json rows file to load instead of inline data.",
        },
        path: {
          type: "string",
          description: "Output PNG path in this bot's home. Default charts/plot-<n>.png.",
        },
        attach: {
          type: "boolean",
          description: "Attach the rendered PNG to the chat (default true).",
        },
      },
    },
  },
  {
    name: "add_mcp_server",
    description:
      "Connect an MCP tool server to this workspace when the user asks you to add one and provides the details (URL or command, optional token/headers/env). The server is created immediately and assigned to you. If it needs browser OAuth authorization, an approval card appears in the chat for the user to complete — tell them to click Authorize. Do not invent endpoints; only use details the user provided.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'Display name, e.g. "Brex".' },
        transport: {
          type: "string",
          enum: ["streamable_http", "sse", "stdio"],
          description:
            "streamable_http for modern HTTP servers, sse for legacy HTTP servers, stdio for local commands.",
        },
        endpoint: {
          type: "string",
          description: "HTTPS URL of the remote MCP server (required unless transport is stdio).",
        },
        command: {
          type: "string",
          description:
            "Executable path for stdio transport (required for stdio). Must be allowlisted by the deployment.",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description:
            "Arguments for the stdio command. A single space-separated string also works.",
        },
        env: {
          type: "object",
          description: 'Environment variables for stdio transport, e.g. {"API_KEY": "..."}.',
        },
        headers: {
          type: "object",
          description: 'HTTP headers for remote transports, e.g. {"Authorization": "Bearer ..."}.',
        },
        secret: {
          type: "string",
          description: "Static access token, equivalent to an Authorization: Bearer header.",
        },
        assign_to_self: {
          type: "boolean",
          description:
            "Assign the server to you so its tools are usable in this conversation (default true).",
        },
      },
      required: ["name", "transport"],
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
  // Semantic-memory tools: exposed by selectMemoryTools() only when a
  // workspace memory provider is configured (which hides `remember`).
  {
    name: "save_memory",
    description:
      "Store a durable fact in this bot's semantic memory (preferences, decisions, recurring context). Use for anything worth recalling in future conversations.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
      },
      required: ["content"],
    },
  },
  {
    name: "recall_memory",
    description: "Semantically search this bot's durable memory for facts relevant to a query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "scratchpad_list",
    description:
      "List this bot's scratchpad / open-work items (todos and parked work). By default omits completed items.",
    inputSchema: {
      type: "object",
      properties: {
        includeDone: {
          type: "boolean",
          description: "When true, include completed items.",
        },
      },
    },
  },
  {
    name: "scratchpad_add",
    description:
      "Add an open-work item to this bot's scratchpad. Use for todos or parked work that should outlive this turn. Not a reminder or schedule.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the item." },
        status: {
          type: "string",
          enum: ["open", "parked", "done"],
          description: "Defaults to open.",
        },
        notes: { type: "string", description: "Optional notes." },
      },
      required: ["title"],
    },
  },
  {
    name: "scratchpad_update",
    description: "Update a scratchpad item's title, status, or notes.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        title: { type: "string" },
        status: { type: "string", enum: ["open", "parked", "done"] },
        notes: { type: "string" },
      },
      required: ["itemId"],
    },
  },
  {
    name: "scratchpad_complete",
    description: "Mark a scratchpad item done.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
      },
      required: ["itemId"],
    },
  },
  {
    name: "scratchpad_remove",
    description: "Permanently remove a scratchpad item.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
      },
      required: ["itemId"],
    },
  },
  {
    name: "schedule_create",
    description:
      'Create a reminder or recurring job for this bot. Use for "remind me in 10 minutes" or "every morning send a joke". Repeats: cron or every/unit (min 1 minute). One-shot: runAt, delayMinutes, or delaySeconds.',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short label shown in Routines." },
        prompt: {
          type: "string",
          description: "What the bot should do when the schedule fires.",
        },
        cron: { type: "string", description: "5-field cron for repeating schedules." },
        every: { type: "number", description: "Repeat interval amount for repeating schedules." },
        unit: {
          type: "string",
          enum: ["minutes", "hours", "days"],
          description: "Unit for every (minimum 1 minute).",
        },
        runAt: {
          type: "string",
          description: "ISO datetime for a one-shot schedule.",
        },
        delayMinutes: {
          type: "number",
          description: "Minutes from now for a one-shot schedule.",
        },
        delaySeconds: {
          type: "number",
          description: "Seconds from now for a one-shot schedule (may be under one minute).",
        },
        timezone: { type: "string", description: "IANA timezone (default UTC)." },
      },
      required: ["name", "prompt"],
    },
  },
  {
    name: "schedule_list",
    description: "List this bot's active and inactive schedules (routines).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "schedule_cancel",
    description: "Cancel a schedule by routineId or exact name.",
    inputSchema: {
      type: "object",
      properties: {
        routineId: { type: "string" },
        name: { type: "string" },
      },
    },
  },
  {
    name: "skill_read",
    description:
      "Load a Claude Agent Skill (SKILL.md recipe) by exact name. Call this when a catalog skill matches the user's request, then follow it immediately.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact skill name from the catalog." },
      },
      required: ["name"],
    },
  },
  {
    name: "skill_create",
    description:
      "Create a reusable Claude Agent Skill (generic how-to SKILL.md) shared across assistants. The Pi runtime already understands this format; we persist and inject them. Use when a multi-step task is worth repeating or the user asks to save a skill. Do not include account names, channels, or inboxes — those belong in a routine.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short skill name." },
        description: {
          type: "string",
          description: "When to use this skill (shown in the / picker and used for auto-use).",
        },
        body: {
          type: "string",
          description: "Markdown steps and guidance after the frontmatter.",
        },
        content: {
          type: "string",
          description:
            "Optional full SKILL.md (frontmatter + body) instead of name/description/body.",
        },
      },
    },
  },
  {
    name: "skill_update",
    description:
      "Update a user-created skill by name or id. Builtin and plugin skills are read-only.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Current exact skill name." },
        skillId: { type: "string" },
        newName: { type: "string" },
        description: { type: "string" },
        body: { type: "string" },
        content: { type: "string", description: "Optional full replacement SKILL.md." },
      },
    },
  },
  {
    name: "skill_delete",
    description:
      "Delete a user-created skill by name or id. Builtin and plugin skills cannot be deleted.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        skillId: { type: "string" },
      },
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
    name: "archive_bot",
    description:
      "Archive a bot this bot created. Archiving stops its work and routines, hides it from the active list, and preserves its conversation, memory, and files for the user to restore or delete later. confirm_name must exactly match its name. This cannot archive you, bots the user created, or bots another bot created.",
    inputSchema: {
      type: "object",
      properties: {
        confirm_name: { type: "string", description: "Exact current name of the bot to archive." },
        bot_id: {
          type: "string",
          description:
            "Optional bot id. If omitted, the unique bot this bot created with confirm_name is archived.",
        },
      },
      required: ["confirm_name"],
    },
  },
  {
    name: "message_bot",
    description:
      "Send a useful update, question, or result to another of the user's bots. Delivery is async and does not end your turn. Continue independent work; do not poll or send ack-only messages. Later updates only if they add something new.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "Target bot id from your teammate list." },
        confirm_name: {
          type: "string",
          description: "Exact name of the target bot when bot_id is omitted.",
        },
        message: { type: "string", description: "What to send." },
      },
      required: ["message"],
    },
  },
  {
    name: "handoff_to_bot",
    description:
      "In a group chat only: hand the next stage to another current member. Appends a visible handoff in the shared thread and starts that bot asynchronously.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "Target member bot id." },
        confirm_name: {
          type: "string",
          description: "Exact name of the target member when bot_id is omitted.",
        },
        message: { type: "string", description: "What the receiving bot should do next." },
      },
      required: ["message"],
    },
  },
];
