import type { ConnectorTool } from "@rakazo/adapter-kit";
import {
  ATTACHMENT_MAX_COUNT,
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  ComputerModeSchema,
  FEEDBACK_DESCRIPTION_MAX_LENGTH,
  FEEDBACK_KINDS,
  MemoryScopeSchema,
  ReplyModeSchema,
  TEAM_CHAT_RULES_MAX_LENGTH,
  ThinkingLevelSchema,
} from "@rakazo/contracts";
import { scheduleCreateBranch } from "./builtin-work.tool-definition.js";

const childRoutineTargetProperties = {
  bot_id: { type: "string", description: "Id of a bot in this space." },
  bot_name: { type: "string", description: "Exact name of a bot in this space." },
};

/** Same exactly-one-timing-method rule as schedule_create, without watches, plus the target bot. */
const createChildRoutineInputSchema = {
  oneOf: [
    scheduleCreateBranch(["cron"], childRoutineTargetProperties),
    scheduleCreateBranch(["every", "unit"], childRoutineTargetProperties),
    scheduleCreateBranch(["runAt"], childRoutineTargetProperties),
    scheduleCreateBranch(["delayMinutes"], childRoutineTargetProperties),
    scheduleCreateBranch(["delaySeconds"], childRoutineTargetProperties),
  ],
};

const fleetBotTargetProperties = {
  bot_id: { type: "string", description: "Id of the bot." },
  bot_name: { type: "string", description: "Exact name of the bot." },
};

const fleetGroupTargetProperties = {
  group_id: { type: "string", description: "Id of the group." },
  group_name: { type: "string", description: "Exact name of the group." },
};

/** Skill, helper, bot, group, preference and feedback tools. */
export const fleetTools: ConnectorTool[] = [
  {
    name: "skill_read",
    description:
      "Load a skill (a reusable how-to recipe) by exact name. Call this when a catalog skill matches the user's request, then follow it immediately. When the result lists files, read one by calling again with its path in file.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact skill name from the catalog." },
        file: {
          type: "string",
          description: "Optional path of one of the skill's files, e.g. references/billing.md.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "skill_create",
    description:
      "Create a skill: a reusable, generic how-to recipe. Use when a multi-step task is worth repeating or the user asks to save a skill. Do not include account names, channels, or inboxes — those belong in a routine.",
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
      "Delegate a task to an independent subagent. Returns immediately; its result comes back later. You remain available to the user. Never call this because the user asked to create a bot — that is spawn_bot, and spawn_bot alone.",
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
        model_provider: {
          type: "string",
          description: "Provider id (e.g. opencode-go). Set together with model_id.",
        },
        model_id: {
          type: "string",
          description: "Model id or provider/id. Set together with model_provider.",
        },
      },
      required: ["name", "task"],
    },
  },
  {
    name: "create_space",
    description:
      "Propose a new space in the current organization when the user asks for a separate data boundary. A space can contain many bots and groups, but its chats, files, memory, tools, and integrations stay isolated from other spaces. Creating the space is the whole action; do not create bots in it unless the user asks later.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: 60,
          description: 'Short display name, e.g. "Customer support".',
        },
      },
      required: ["name"],
    },
  },
  {
    name: "spawn_bot",
    description:
      "Create a full, regular bot — the same kind the user creates from the + button. It gets its own thread, computer, and memory, and appears as a peer in the bot list. Do not also call run_subagent. To give the new bot more than instructions (skills, routines, memories, apps to connect) or a task the user wants started, put it in prompt; the bot sets itself up from it. Otherwise creating the bot is the whole action.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: {
          type: "string",
          maxLength: BOT_DESCRIPTION_MAX_LENGTH,
          description:
            "Short public summary of what the new bot is for. Teammates see it in their bot directory.",
        },
        instructions: {
          type: "string",
          maxLength: BOT_INSTRUCTIONS_MAX_LENGTH,
          description:
            "Private operating instructions for the new bot. Only that bot sees them, as its system prompt.",
        },
        prompt: {
          type: "string",
          description:
            "Optional first message to the new bot, which it acts on at once in its own thread: everything it should set up for itself, in full, or the task to start.",
        },
        computer_mode: {
          type: "string",
          enum: ["team", "dedicated"],
          description:
            "Optional. team shares one screen with other Team bots; dedicated (Private) gets its own. Defaults to team.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "update_bot",
    description:
      "Read or change your own settings. Call with no fields to read them and the models and thinking levels you can pick. Long instructions come in pages; follow instructionsNextOffset before replacing them. If a read comes back with contextTruncated, it was shortened: say so, do not rewrite. Pass fields to change them, only when the user asks; setting your name, description and first instructions when you have none is fine. Never claim a change without calling this.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Display name shown in the chat header and bot list.",
        },
        description: {
          type: "string",
          description:
            "Short public summary of what this bot does. Teammates see it in their bot directory. It does not change your instructions.",
        },
        color: {
          type: "string",
          description:
            "Avatar color or encoded shape, e.g. #8B5CF6 or #8B5CF6::shape_3. Do not pass http URLs.",
        },
        artifact_id: {
          type: "string",
          description:
            "Image artifact in this space to use as the profile picture. Prefer an image the user attached in this chat.",
        },
        use_attached_image: {
          type: "boolean",
          description: "Use the latest image attached to this message as the profile picture.",
        },
        // Explained in the update_bot instructions; kept short for the listed-tool budget.
        dailyCheckIns: { type: "boolean" },
        notifyOnFinish: {
          type: "boolean",
          description: "Notify the user when this bot finishes a run.",
        },
        instructions: {
          type: "string",
          maxLength: BOT_INSTRUCTIONS_MAX_LENGTH,
          description:
            "Your private operating instructions, replaced as a whole: include what should stay. Read every page before replacing them.",
        },
        instructions_offset: {
          type: "integer",
          minimum: 0,
          description: "Character offset to read long instructions from.",
        },
        model: {
          type: "string",
          description: 'Model to run on: a name like "Claude Sonnet" or an exact id.',
        },
        thinkingLevel: {
          type: "string",
          enum: [...ThinkingLevelSchema.options],
          description:
            "How hard you reason; raise it when asked to think harder, lower it for speed.",
        },
        readAloud: {
          type: "boolean",
          description: "Read your replies aloud.",
        },
        voice: {
          type: "string",
          description: 'Voice to read replies in: a voice name, or "default".',
        },
        replyMode: {
          type: "string",
          enum: [...ReplyModeSchema.options],
          description: "messages: only what you send reaches people.",
        },
        teamChatAmbientEnabled: {
          type: "boolean",
          description: "Read all team chat, not only mentions.",
        },
        teamChatRules: { type: "string", maxLength: TEAM_CHAT_RULES_MAX_LENGTH },
        memoryScope: { type: "string", enum: [...MemoryScopeSchema.options] },
        disableTools: {
          type: "array",
          items: { type: "string" },
          description: "Built-in tools to turn off.",
        },
        computer: {
          type: "string",
          enum: [...ComputerModeSchema.options],
          description: "With bot_id only.",
        },
        bot_id: {
          type: "string",
          description: "A bot in this space, to change it instead of yourself.",
        },
      },
    },
  },
  {
    name: "list_fleet",
    description:
      "List the bots and groups in this space with their ids, sections, pinned state and models. You can manage every bot listed; createdByMe only says which ones you created. Pass bot_id of a bot in this space to read only its full instructions and instructionsVersion, which set_child_instructions needs as expected_version. Call this before changing the bots you manage.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: {
          type: "string",
          description:
            "A bot in this space, to read its instructions and version instead of the roster.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_group",
    description:
      "Create a group of 2 to 10 of this user's bots. Pass bot_ids or bot_names (exact).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        bot_ids: { type: "array", items: { type: "string" } },
        bot_names: { type: "array", items: { type: "string" } },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "update_group",
    description:
      "Rename a group or add and remove its members. Works on any group of this user, not only ones you created. Identify it by group_id or group_name (exact). A group keeps 2 to 10 members.",
    inputSchema: {
      type: "object",
      properties: {
        ...fleetGroupTargetProperties,
        name: { type: "string", minLength: 1, description: "New group name." },
        add_bot_ids: { type: "array", items: { type: "string" } },
        remove_bot_ids: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "organize_bot",
    description:
      "Move a bot or group into a sidebar section, clear its section, or pin and unpin it. Works on any bot or group of this user, not only ones you created. Identify it by bot_id, bot_name, group_id or group_name (exact). section is a section name; clear_section: true takes it out of its section.",
    inputSchema: {
      type: "object",
      properties: {
        ...fleetBotTargetProperties,
        ...fleetGroupTargetProperties,
        section: { type: "string", minLength: 1, description: "Section name." },
        clear_section: { type: "boolean", description: "Take it out of its section." },
        pinned: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "set_child_instructions",
    description:
      "Replace the instructions of a bot in this space. Identify it by bot_id or bot_name (exact). Pass expected_version from list_fleet with that bot_id. One instruction edit per bot per run. Needs the owner's approval.",
    inputSchema: {
      type: "object",
      properties: {
        ...fleetBotTargetProperties,
        instructions: { type: "string", minLength: 1, maxLength: BOT_INSTRUCTIONS_MAX_LENGTH },
        expected_version: {
          type: "string",
          description: "instructionsVersion from list_fleet for that bot.",
        },
      },
      required: ["instructions", "expected_version"],
      additionalProperties: false,
    },
  },
  {
    name: "set_child_bot_model",
    description:
      "Set the model of a bot in this space, or reset it to the default with clear: true. Identify it by bot_id or bot_name (exact). Needs the owner's approval.",
    inputSchema: {
      type: "object",
      properties: {
        ...fleetBotTargetProperties,
        model: {
          type: "string",
          description: 'A name like "Claude Sonnet" or an exact id.',
        },
        provider: { type: "string", description: "Optional; limits model to this provider." },
        thinking_level: { type: "string" },
        clear: { type: "boolean", description: "Reset to the default model." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_child_routine",
    description:
      "Schedule a routine that wakes a bot in this space in its own thread. Identify it by bot_id or bot_name (exact). Repeats: cron or every/unit (min 1 minute). One-shot: runAt, delayMinutes, or delaySeconds. on: events, as in schedule_create.",
    inputSchema: createChildRoutineInputSchema,
  },
  {
    name: "archive_bot",
    description:
      "Archive another bot in this space. Archiving stops its work and routines, hides it from the active list, and preserves its conversation, memory, and files for the user to restore or delete later. confirm_name must exactly match its name. This cannot archive you.",
    inputSchema: {
      type: "object",
      properties: {
        confirm_name: { type: "string", description: "Exact current name of the bot to archive." },
        bot_id: {
          type: "string",
          description:
            "Optional bot id. If omitted, the unique bot in this space with confirm_name is archived.",
        },
      },
      required: ["confirm_name"],
    },
  },
  {
    name: "message_bot",
    description:
      'Send an update, question or result to another of the user\'s bots. Only this tool delivers it: a message written in your reply, such as "[to Comms] …", never reaches them. Delivery is async, so keep working; send no acknowledgements or repeats.',
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "Target bot id from your teammate list." },
        confirm_name: { type: "string", description: "Target's exact name, if no bot_id." },
        message: { type: "string", description: "Send code, logs and long content as files." },
        files: {
          type: "array",
          items: { type: "string" },
          maxItems: ATTACHMENT_MAX_COUNT,
          description:
            "Paths on your computer to send, never their contents. A bot with its own computer gets copies, so zip folders for it.",
        },
        intent: {
          type: "string",
          enum: ["request", "result", "question", "status", "fyi"],
          description: "What the recipient should do with it. Defaults to request.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "handoff_to_bot",
    description:
      "Transfer a genuinely distinct next stage to another current group member, or return a completed stage to the member that handed it to you when that member is coordinating the work. In a group, stay in that group. Outside a group, supply group_id from your groups list to coordinate there. Appends a visible handoff and starts that bot asynchronously. Never hand back unfinished work; otherwise post results in the shared thread.",
    inputSchema: {
      type: "object",
      properties: {
        group_id: {
          type: "string",
          description:
            "Explicit destination from your groups list; required outside a group, omitted in a group.",
        },
        bot_id: { type: "string", description: "Target member bot id." },
        confirm_name: {
          type: "string",
          description: "Exact name of the target member when bot_id is omitted.",
        },
        message: {
          type: "string",
          description:
            "What the receiving bot should do next. Send code, logs or other long content as files instead.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          maxItems: ATTACHMENT_MAX_COUNT,
          description:
            "Paths of files or folders on your computer to send with it. A bot on your computer reads them in place; one with its own computer gets copies, so zip a folder for it. Never paste file contents into message.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "post_to_group",
    description:
      "Post a message as yourself in one of your groups. Wakes no member; use handoff_to_bot for that.",
    inputSchema: {
      type: "object",
      properties: {
        group_id: { type: "string", description: "Group id from your groups list." },
        group_name: { type: "string", description: "Exact group name, if no group_id." },
        message: { type: "string", description: "Send code, logs and long content as files." },
        files: {
          type: "array",
          items: { type: "string" },
          maxItems: ATTACHMENT_MAX_COUNT,
          description: "Paths on your computer to attach, never their contents. Zip folders.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "update_preferences",
    description:
      "Read or change the user's app preferences. Change only what the user asks. Omit fields to read. A null result for a chat preference means there is no account override. Use update_bot for the agent's own model. Email, password, sign-in, billing and deletion require the app's settings.",
    inputSchema: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          description: 'IANA timezone, e.g. "America/New_York".',
        },
        marketingEmails: {
          type: "boolean",
          description: "false unsubscribes from Rakazo's product emails; true resubscribes.",
        },
        composerModelPicker: {
          type: "boolean",
          description: "Enable inline model switching in the chat composer.",
        },
        streamReplies: {
          type: "boolean",
          description: "Show replies as they are written.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "feedback",
    description:
      "Send a bug report or product feedback about Rakazo to the people who run this server. Only when the user asks you to report something. Describe what happened and what was expected in general terms; leave out names, contact details, message text, credentials and other personal details. The report already identifies this chat, bot and run.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...FEEDBACK_KINDS] },
        description: {
          type: "string",
          maxLength: FEEDBACK_DESCRIPTION_MAX_LENGTH,
          description: "What went wrong or what the user suggests, without personal details.",
        },
      },
      required: ["kind", "description"],
      additionalProperties: false,
    },
  },
];
