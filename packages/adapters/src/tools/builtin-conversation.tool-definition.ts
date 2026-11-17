import type { ConnectorTool } from "@rakazo/adapter-kit";
import {
  BOT_MEMORY_MAX_BYTES,
  BotSecretName,
  botSecretDestinationSchema,
  GenerateSecretInput,
  LOGIN_FIELD_LIMIT,
  SecretAskPurpose,
  SecretHttpRequest,
} from "@rakazo/contracts";
import { z } from "zod";
import { messageUserMaxLength } from "../runs/lifecycle/user-progress.js";
import { allowPrivateHttpSecretOrigins } from "../secrets/bot-secrets.js";

// The owner flag can land in process.env after static imports run (loadRootEnv
// parses .env once the entry module is already executing), so the model-facing
// surface is built lazily on first tool access instead of at module scope.
let secretAskSurface:
  | {
      description: string;
      inputSchema: ConnectorTool["inputSchema"];
    }
  | undefined;
function secretAskToolSurface() {
  const allowPrivateHttpOrigins = allowPrivateHttpSecretOrigins();
  secretAskSurface ??= {
    description: `Collect a credential in a masked field. Supply credential to save a named API credential for this bot and user at one ${
      allowPrivateHttpOrigins
        ? "HTTPS origin, or an HTTP origin on a private LAN host"
        : "HTTPS origin"
    }, or connectionId for a one-use connector code. Credential names must start with a lowercase letter and use only lowercase letters, digits, hyphens, or underscores (max 64 characters). For a website login the user wants saved, use auth {type:"login"} with the HTTPS origin of the sign-in form's page or frame, and fields with the labels the site signs in with (default Username and Password); the card asks for each, and browser_act fill_secret types one by its label. The user decides which fields are hidden: a hidden field is typed only into a password field. A field whose label is an ID, phone, email or username starts visible on the card and any other starts hidden, so label each field by what the site calls it. If one is refused in another field, ask again with replace true so the user can make it visible. The user may choose not to save a login: the result then says saved false, the login works only until this run ends, and a later run must ask again, so never say it was saved. For a value this bot's shell commands need, use auth {type:"command"} with no origin; it is exported to them as an environment variable named after the credential in upper case with hyphens as underscores (netbird-setup-key becomes $NETBIRD_SETUP_KEY). Use auth {type:"card"} for a payment card, which you see only as brand, last four and expiry, and {type:"contact"} for an address, phone or email named for who or where (home, mom); neither has an origin. Existing named credentials are reused unless replace is true, as is a site's saved login. A sign-in without a password, such as fields ["ID number","Phone"], still uses auth {type:"login"}; never ask for those in chat or on the screen. For a code the site texted or emailed, use oneTimeCode {origin} with the page's HTTPS origin: you never see the code, browser_act fill_code types it, and a wrong or new code needs a new request. Never ask for a code in chat. For CAPTCHA, passkeys, or anything else that needs the live desktop, call request_takeover.`,
    inputSchema: {
      oneOf: [
        {
          type: "object",
          properties: {
            label: { type: "string" },
            purpose: { type: "string", enum: SecretAskPurpose.options },
            // Input shape, so origin stays optional for a command variable.
            credential: z.toJSONSchema(
              botSecretDestinationSchema({ allowPrivateHttpOrigin: allowPrivateHttpOrigins }),
              { io: "input" },
            ),
            replace: {
              type: "boolean",
              description: "Ask the user to replace a saved value or a login's site.",
            },
            fields: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: LOGIN_FIELD_LIMIT,
              description:
                "For a login: the labels of the values the site signs in with, in order, such as Email and Password or ID number and Phone number.",
            },
          },
          required: ["label", "purpose", "credential"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            label: { type: "string" },
            purpose: { type: "string", enum: SecretAskPurpose.options },
            connectionId: { type: "string" },
          },
          required: ["label", "purpose", "connectionId"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            label: { type: "string" },
            purpose: { type: "string", enum: SecretAskPurpose.options },
            oneTimeCode: {
              type: "object",
              properties: { origin: { type: "string" } },
              required: ["origin"],
              additionalProperties: false,
            },
          },
          required: ["label", "purpose", "oneTimeCode"],
          additionalProperties: false,
        },
      ],
    },
  };
  return secretAskSurface;
}

/** Questions, messages, secrets, plots, pages and connectors. */
export const conversationTools: ConnectorTool[] = [
  {
    name: "ask_user",
    description:
      "Ask the user one short multiple-choice question with tappable options, then wait for their selection. Use this instead of asking them to type when two to four concise choices are enough. Put the content the user is deciding about, such as a draft email, in `detail`.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", maxLength: 240 },
        detail: { type: "string", maxLength: 4_000 },
        options: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 80 },
          minItems: 2,
          maxItems: 4,
          uniqueItems: true,
        },
      },
      required: ["question", "options"],
    },
  },
  {
    name: "message_user",
    // Read lazily: the cap comes from process.env, which may be filled after import.
    get description() {
      return `Post a short progress update to the user in this chat immediately. Does not end your turn. Use sparingly during long work for high-signal beats (what you are checking, then a result). Do not dump tool logs, thinking, or a play-by-play of every call. HARD LIMIT: cut off silently at ${messageUserMaxLength()} characters, so never put your final answer, a report, or any long-form content here \u2014 it will arrive mangled and the user will never see the rest. Always write your complete final answer in your normal reply, not here.`;
    },
    get inputSchema() {
      return {
        type: "object",
        properties: {
          message: {
            type: "string",
            maxLength: messageUserMaxLength(),
            description:
              "Short user-visible update, not the final answer \u2014 longer text is silently truncated.",
          },
        },
        required: ["message"],
      };
    },
  },
  {
    name: "request_secret",
    get description() {
      return secretAskToolSurface().description;
    },
    // The original schema is credential XOR connectionId. The wire schema is one
    // object, so a valid credential may also carry connectionId; the executor
    // keeps that credential and uses connectionId only when no credential was sent.
    get inputSchema() {
      return secretAskToolSurface().inputSchema;
    },
  },
  {
    name: "generate_secret",
    description:
      'Create a random password or key and save it for this bot and user; you never see the value. For a new website account, use type "login" with the sign-up site and the username, then type both into the form with browser_act fill_secret; add command: true only when a CLI also needs the password and the site offers no token or browser sign-in for it; that saves it as the command variable <name>-password too. For a value shell commands need, such as a database password you are setting up, use type "command"; it is exported like a request_secret command variable, so pass it from the environment instead of writing it out. Set rules only when the site or tool restricts characters, for example symbols: false for a value inside a URL. An existing credential is never replaced.',
    inputSchema: z.toJSONSchema(GenerateSecretInput, { io: "input" }),
  },
  {
    name: "list_secrets",
    description:
      "List saved credentials with their destinations and command variables, cards (brand, last four, expiry), contacts (all fields) and notes on when to use each. Values are never returned.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "secret_request",
    description:
      "Make an authenticated HTTPS request using a saved credential name. The backend injects authentication only at its saved origin. Redirects are rejected; response echoes of the credential are redacted. Use normal request URLs and bodies without secret placeholders. A paged response returns its Link header as links (request links.next to read on) and paging headers such as x-next-page or x-total-count in headers; when an API pages by headers, build the next page's URL by that API's rules. A missing links.next alone does not mean the list is complete.",
    inputSchema: z.toJSONSchema(SecretHttpRequest, { io: "input" }),
  },
  {
    name: "forget_secret",
    description:
      "Remove a saved credential for this bot and user, preventing future requests from using it.",
    inputSchema: z.toJSONSchema(z.object({ name: BotSecretName })),
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
    name: "save_page",
    description:
      'Save a page the user opens from the chat: a dashboard, report, tracker or comparison. Pass the page as JSX source written against the Rakazo page kit; call with {"help": true} first for the kit guide. Problems come back with line numbers and nothing is saved. To change a page, pass its pageId with edits (applied together, or not at all) or full source; pass only pageId to read its current source. A result with sharedByLink is a page the user shared: anyone with its link sees each save at once.',
    inputSchema: {
      type: "object",
      properties: {
        help: { type: "boolean", description: "Return the page kit guide instead of saving." },
        pageId: { type: "string", description: "The page to read or update." },
        title: { type: "string", description: "Page title; required for a new page." },
        source: { type: "string", description: "The whole page as JSX." },
        edits: {
          type: "array",
          description: "Changes to the current source; each find must occur exactly once.",
          items: {
            type: "object",
            properties: { find: { type: "string" }, replace: { type: "string" } },
            required: ["find", "replace"],
          },
        },
      },
    },
  },
  {
    name: "add_mcp_server",
    description:
      "Connect a remote MCP tool server to this Space when the user asks you to add one and provides the details (URL, optional token/headers). The server is created immediately and an approval card appears in the chat; its tools reach you once the user approves it there. Do not invent endpoints; only use details the user provided. Local (stdio) servers can only be added by an admin in Settings.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'Display name, e.g. "Brex".' },
        transport: {
          type: "string",
          enum: ["streamable_http", "sse"],
          description: "streamable_http for modern HTTP servers, sse for legacy HTTP servers.",
        },
        endpoint: {
          type: "string",
          description: "HTTPS URL of the remote MCP server.",
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
      required: ["name", "transport", "endpoint"],
    },
  },
  {
    name: "remember",
    description: `Save one short new fact to your memory, one call per fact. To change or drop a fact, pass old_text from its entry with new or empty content. Holds ${BOT_MEMORY_MAX_BYTES / 1024} KB.`,
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        old_text: { type: "string" },
      },
      required: ["content"],
    },
  },
  {
    name: "save_shared_memory",
    description:
      "Save a Space shared memory document every bot reads. Replaces the full content, so include everything it should keep.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Document name, for example MEMORY.md." },
        content: { type: "string", description: "The document's complete new content." },
      },
      required: ["path", "content"],
    },
  },
];
