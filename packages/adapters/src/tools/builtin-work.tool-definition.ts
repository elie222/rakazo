import type { ConnectorTool } from "@rakazo/adapter-kit";
import {
  TICKET_COMMENT_MAX_LENGTH,
  TICKET_DESCRIPTION_MAX_LENGTH,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TITLE_MAX_LENGTH,
} from "@rakazo/contracts";
import {
  SCRATCHPAD_NOTES_MAX_LENGTH,
  SCRATCHPAD_TITLE_MAX_LENGTH,
} from "../tasks/scratchpad-tools.js";
import { SCHEDULE_TIMING_FIELDS } from "./schedule-tools.js";

const scheduleCreateProperties = {
  name: { type: "string", description: "Short label shown in Routines." },
  prompt: {
    type: "string",
    description:
      'Concrete steps for when the schedule fires: what to use, what to extract, and how to report. Name the connected plugin tools to call when one covers the data (e.g. GITHUB_LIST_RELEASES for owner/repo), preferring them over the computer browser or web search; for a website without one, describe the pages and actions to take in the computer\'s browser. Write the prompt so it makes sense without this chat. It runs in new circumstances: write the user\'s lasting request in full, keeping every standing item and preference, including their swap and skip rules. A decision that only fit this time, such as an item swapped or skipped because it was out of stock or anything the user said "this week" or "this time" about, becomes a condition, never a permanent change ("skip sourdough if it is out of stock", not "skip sourdough").',
  },
  timezone: { type: "string", description: "IANA timezone (default: the user's timezone)." },
  inChat: {
    type: "boolean",
    description: "Run as a turn in this chat.",
  },
};

const scheduleTimingNames = [...SCHEDULE_TIMING_FIELDS, "watch"] as const;

/**
 * Model serializers often emit unused optional fields as null or "". Those are
 * not a second timing method; a real value in another method still fails the branch.
 */
const blankScheduleTiming = {
  anyOf: [{ type: "null" }, { type: "string", pattern: "^\\s*$" }],
};

const scheduleTimingSpecs = {
  cron: { type: "string", description: "5-field cron for repeating schedules." },
  every: { type: "number", description: "Repeat interval amount for repeating schedules." },
  unit: {
    type: "string",
    enum: ["minutes", "hours", "days"],
    description: "Unit for every (minimum 1 minute).",
  },
  runAt: {
    type: "string",
    description: "ISO datetime for a one-shot schedule; without an offset, read in timezone.",
  },
  delayMinutes: {
    type: "number",
    description: "Minutes from now for a one-shot schedule.",
  },
  delaySeconds: {
    type: "number",
    description: "Seconds from now for a one-shot schedule (may be under one minute).",
  },
  watch: {
    type: "object",
    description:
      'Run when something changes; quiet checks use no model. everyMinutes: 5–1440 (default 15). Do not combine watch with cron/every/startAt. files: computer paths. command: shell command in your folder, repeated without per-run approval; compare its output. tool: read-only connected tool + args; an arg {{today}} or {{today+2d}} is that date. http: public HTTPS url, GET only; no headers, auth, body or redirects. Prefer tool/http for network checks: no computer; files/command wake it. Watch one named resource, not a whole account. For JSON lists, track names the identity then changed fields: mail search ["id"], Drive folder ["id","modifiedTime"], ClickUp list ["id","date_updated"].',
    properties: {
      kind: { type: "string", enum: ["files", "command", "tool", "http"] },
      paths: { type: "array", items: { type: "string" } },
      command: { type: "string" },
      url: { type: "string" },
      tool: { type: "string" },
      args: { type: "object" },
      track: {
        type: "array",
        items: { type: "string" },
        description:
          "For JSON: identity field, then fields whose changes count. Other fields are ignored. HTTP watches detect changes only; other kinds can name changed items.",
      },
      everyMinutes: { type: "number" },
      loud: {
        type: "boolean",
        description: "Also post 'No changes' in chat on quiet checks.",
      },
    },
    required: ["kind"],
  },
};

/** Events that start the routine besides its timing, or instead of it. */
const routineEventsSpec = {
  type: "object",
  properties: {
    webhook: { type: "boolean" },
    git: { type: "boolean" },
    chat: { type: "string" },
    email: { type: "string", enum: ["owner", "domain"] },
  },
  additionalProperties: false,
};

/** As with timing, a serializer's null or blank for an unused `on` is no events. */
const optionalRoutineEvents = { anyOf: [routineEventsSpec, ...blankScheduleTiming.anyOf] };

const startAtSpec = {
  type: "string",
  description:
    "ISO date or datetime a repeating schedule starts; the first run is the first match at or after it. Without an offset, read in timezone. If you already did this period's work yourself, set startAt so the first run does not repeat it.",
};

/**
 * One way to time a routine. Repeats and watches also take events (`on`); the cron branch leaves
 * cron optional, so a routine that only events start matches it alone.
 */
export function scheduleCreateBranch(
  active: readonly (keyof typeof scheduleTimingSpecs)[],
  extraProperties: Record<string, unknown> = {},
) {
  const activeNames = new Set<string>(active);
  const properties: Record<string, unknown> = { ...extraProperties, ...scheduleCreateProperties };
  for (const name of scheduleTimingNames) {
    properties[name] = activeNames.has(name) ? scheduleTimingSpecs[name] : blankScheduleTiming;
  }
  // Optional here, so a serializer's null for it means no cron, as in the other branches.
  if (activeNames.has("cron")) {
    properties.cron = { anyOf: [scheduleTimingSpecs.cron, { type: "null" }] };
  }
  const repeats = activeNames.has("cron") || activeNames.has("every");
  properties.on = repeats || activeNames.has("watch") ? optionalRoutineEvents : blankScheduleTiming;
  properties.startAt = repeats ? startAtSpec : blankScheduleTiming;
  return {
    type: "object",
    properties,
    // A watch never runs in its chat: what it read is not the user's words. cron is optional, so
    // a routine only events start matches the cron branch alone.
    required: [
      "name",
      "prompt",
      ...(activeNames.has("watch") ? [] : ["inChat"]),
      ...active.filter((name) => name !== "cron"),
    ],
    additionalProperties: false,
  };
}

/** Another bot in this space whose routines the call reaches; needs bot management. */
const otherBotRoutineProperties = { bot_id: { type: "string" }, bot_name: { type: "string" } };

/** Exactly one timing method. Null or blank leftovers stay valid so callers can ignore them. */
const scheduleCreateInputSchema = {
  oneOf: [
    scheduleCreateBranch(["cron"]),
    scheduleCreateBranch(["every", "unit"]),
    scheduleCreateBranch(["runAt"]),
    scheduleCreateBranch(["delayMinutes"]),
    scheduleCreateBranch(["delaySeconds"]),
    scheduleCreateBranch(["watch"]),
  ],
};

/** Task, scratchpad, board, schedule and call tools. */
export const workTools: ConnectorTool[] = [
  {
    name: "task_catalog",
    description:
      "Read-only inventory and source of truth for this bot's real open tasks, saved routines, taught skills, reusable skills, and currently exposed tools. Call it before claiming a task or skill exists. Use the returned ids and exact names; do not infer capabilities from memory or conversation text.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
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
        title: {
          type: "string",
          maxLength: SCRATCHPAD_TITLE_MAX_LENGTH,
          description: "Short title for the item.",
        },
        status: {
          type: "string",
          enum: ["open", "parked", "done"],
          description: "Defaults to open.",
        },
        notes: {
          type: "string",
          maxLength: SCRATCHPAD_NOTES_MAX_LENGTH,
          description: "Optional notes.",
        },
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
        title: { type: "string", maxLength: SCRATCHPAD_TITLE_MAX_LENGTH },
        status: { type: "string", enum: ["open", "parked", "done"] },
        notes: {
          type: "string",
          maxLength: SCRATCHPAD_NOTES_MAX_LENGTH,
          description: "Replaces the current notes.",
        },
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
    name: "board_tickets",
    description: "List tickets. Continue with nextCursor when returned.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: TICKET_STATUSES, description: "Filter by status." },
        ownerBotId: { type: "string", description: "Filter by owner bot id." },
        cursor: {
          type: "string",
          description: "nextCursor from the previous page. Omit for the first page.",
        },
      },
    },
    readOnly: true,
  },
  {
    name: "ticket_get",
    description: "Read a ticket by reference or id, with comments.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Ticket reference such as RAK-42, or the ticket id." },
      },
      required: ["ref"],
    },
    readOnly: true,
  },
  {
    name: "ticket_create",
    description: "Create a ticket. Owner defaults to you.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          maxLength: TICKET_TITLE_MAX_LENGTH,
          description: "Short ticket title.",
        },
        description: {
          type: "string",
          maxLength: TICKET_DESCRIPTION_MAX_LENGTH,
          description: "Optional detail.",
        },
        priority: {
          type: "string",
          enum: TICKET_PRIORITIES,
          description: "Priority. Defaults to normal.",
        },
        ownerBotId: {
          type: "string",
          description: "Bot in this space to own it. Defaults to you.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "ticket_update",
    description: "Update a ticket, including status and owner.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Ticket id." },
        title: { type: "string", maxLength: TICKET_TITLE_MAX_LENGTH },
        description: { type: "string", maxLength: TICKET_DESCRIPTION_MAX_LENGTH },
        priority: { type: "string", enum: TICKET_PRIORITIES },
        status: { type: "string", enum: TICKET_STATUSES },
        ownerBotId: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "ticket_comment",
    description: "Add a ticket comment.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Ticket id." },
        body: {
          type: "string",
          maxLength: TICKET_COMMENT_MAX_LENGTH,
          description: "Comment text.",
        },
      },
      required: ["id", "body"],
    },
  },
  {
    name: "schedule_create",
    description:
      'Create a reminder or recurring job for this bot. Use for "remind me in 10 minutes" or "every morning send a joke". Repeats: cron or every/unit (min 1 minute), optionally from startAt. One-shot: runAt, delayMinutes, or delaySeconds. A repeating job carries out the user\'s lasting request each time, not a copy of what was decided today. inChat true only when each run continues work this chat is doing, such as updating a draft or plan written here or fixing something started here; it then waits for work under way here. Otherwise false: it runs on time, seeing this chat\'s latest messages and its own earlier results. on: run on events too, or only (no timing); each run receives the event: webhook, git (a GitHub repo webhook the user adds with the routine URL and key; needs no connected app), chat (your connected chat app, by name), email (to your address from the owner or their domain).',
    inputSchema: scheduleCreateInputSchema,
  },
  {
    name: "schedule_list",
    description: "List this bot's active and inactive schedules (routines), or another bot's.",
    inputSchema: { type: "object", properties: otherBotRoutineProperties },
  },
  {
    name: "schedule_update",
    description:
      "Edit one of this bot's schedules, or another bot's by bot_id or exact bot_name, by routineId instead of cancelling and recreating it. Send only what changes. Timing fields replace the current timing; startAt alone moves the next run of the current repeat. active false pauses it. The result's changes lists each field that changed with its before and after; the prompt is returned only there. A watch has no timing fields; everyMinutes changes how often it checks. on replaces the routine's events; {} removes them.",
    inputSchema: {
      type: "object",
      properties: {
        routineId: { type: "string" },
        ...scheduleCreateProperties,
        active: { type: "boolean" },
        cron: scheduleTimingSpecs.cron,
        every: scheduleTimingSpecs.every,
        unit: scheduleTimingSpecs.unit,
        startAt: startAtSpec,
        runAt: scheduleTimingSpecs.runAt,
        delayMinutes: scheduleTimingSpecs.delayMinutes,
        delaySeconds: scheduleTimingSpecs.delaySeconds,
        everyMinutes: {
          type: "integer",
          minimum: 5,
          maximum: 1440,
          description: "A watch's check interval in minutes.",
        },
        on: optionalRoutineEvents,
        ...otherBotRoutineProperties,
      },
      required: ["routineId"],
    },
  },
  {
    name: "schedule_cancel",
    description:
      "Cancel a schedule by routineId or exact name; another bot's by bot_id or exact bot_name.",
    inputSchema: {
      type: "object",
      properties: {
        routineId: { type: "string" },
        name: { type: "string" },
        ...otherBotRoutineProperties,
      },
    },
  },
  {
    name: "end_call",
    description:
      "End the current voice call. Call this when the user asks to hang up or end the call, or the conversation is clearly finished. Your farewell is spoken as the call ends, so do not also say goodbye in text; finish any remaining work in chat afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: 'What the call was about, 2-5 words, e.g. "AI stack flow". Max 40 chars.',
        },
        farewell: {
          type: "string",
          description: "One short sentence spoken as you hang up. Max 160 chars.",
        },
      },
      required: ["title", "farewell"],
    },
  },
  {
    name: "call_user",
    description:
      "Ring the user's devices for a voice call. Use when the user asked you to call them, or when you have reminded them about the same thing three times and they have not replied. Your opening is spoken the moment they answer, then the conversation continues on the call. If they miss or decline it, the chat shows a missed call. Never call for routine updates a message can carry.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            'Why you are calling, shown on the incoming call, e.g. "3 reminders without a reply: send the report". Max 120 chars.',
        },
        opening: {
          type: "string",
          description:
            "The first thing you say when they answer, one or two short spoken sentences in the user's language. Max 240 chars.",
        },
      },
      required: ["reason", "opening"],
    },
  },
];
