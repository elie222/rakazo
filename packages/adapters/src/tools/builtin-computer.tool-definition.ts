import type { ConnectorTool } from "@rakazo/adapter-kit";
import { PURCHASE_CARD_FIELDS } from "@rakazo/contracts";
import { BROWSER_ACT_KINDS } from "../browser/browser-tools.js";

export const READ_FILE_MAX_BYTES = 250_000;
export const READ_FILE_MAX_KB = READ_FILE_MAX_BYTES / 1000;

/** Media, computer, browser, file and desktop app tools. */
export const computerTools: ConnectorTool[] = [
  {
    name: "generate_image",
    description:
      "Generate one image from a prompt and attach it to chat. Uses the deployment media model and may incur charges. Do not retry failed submissions automatically.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string", minLength: 1, maxLength: 4000 } },
      required: ["prompt"],
    },
    readOnly: false,
  },
  {
    name: "generate_video",
    description:
      "Submit a short video from a prompt (may incur charges). It is attached to the chat when ready, without polling; pass jobId only to check progress. Do not resubmit failed or uncertain jobs automatically.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 4000 },
        jobId: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
    readOnly: false,
  },
  {
    name: "computer_observe",
    description:
      "Capture the current screen of this bot's computer. Returns frame metadata and an image. Observe before coordinate-based actions and whenever another actor may have changed the desktop.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "computer_act",
    description:
      "Perform up to 24 ordered desktop actions on this bot's computer and return the resulting screen. Batch only predictable actions; stop before an outcome you need to inspect. Action kinds: click, move, down, up, type, key, scroll, wait, focus (raises the application's window, launching it if absent). Scroll turns the wheel at x,y; put them on the area to scroll, as for a click. Without them it scrolls wherever the pointer is. Direction up, down, left or right; amount 1-20 wheel notches, default 3.",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          items: {
            oneOf: [
              {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["focus"] },
                  application: { type: "string", minLength: 1, pattern: "\\S" },
                  uri: { type: "string" },
                },
                required: ["kind", "application"],
              },
              {
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
                  direction: { type: "string", enum: ["up", "down", "left", "right"] },
                  amount: { type: "number" },
                  ms: { type: "number" },
                  application: { type: "string" },
                  uri: { type: "string" },
                },
                required: ["kind"],
              },
            ],
          },
        },
        observe: { type: "boolean" },
        settle_ms: { type: "number" },
      },
      required: ["actions"],
    },
  },

  {
    name: "browser_navigate",
    description:
      'Open a URL in the page browser on this bot\'s computer and return the page like browser_snapshot, or for a file download its saved path in downloads. Prefer this over pixel clicks for web pages. If the result includes fallback:"computer_act", use computer_act on the desktop browser instead.',
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "http(s) URL to open." },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Capture an accessibility-style snapshot of the current page with element refs (e1, e2, …). Use refs with browser_act. A dropdown lists its options, and a line says when page text or controls were cut off. query lists only the controls whose name, label or nearby text match it, from anywhere on the page. Frames follow the page, under their site. Prefer this over computer_observe for web pages. If loading is true, take another snapshot before deciding what the page shows. If fallback is computer_act, use the desktop tools instead.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 200 },
      },
    },
    readOnly: true,
  },
  {
    name: "browser_act",
    description: `Click or fill page elements by ref from browser_snapshot (kinds: ${BROWSER_ACT_KINDS.join(", ")}). click is a real mouse click, and fill on a dropdown takes one of its options' visible labels or values. The result shows the page after the action, and a snapshot covers the whole page, so scrolling is rarely needed. upload attaches your files to a "file upload" element; use it instead of clicking upload buttons. fill_secret types one field of a login saved with request_secret, by its label, only on its sites (in a frame: only its own site); you never see the value. fill_card types an approved purchase's card or a saved card, only on its approved site; leave out ref to find the field, even in a payment frame. fill_code types a oneTimeCode once on its site, or with secret a login's authenticatorCode. fill_pay_token hands an approved purchase's pay token to its checkout; no ref. type presses keys like a keyboard and replaces the field's text; use it for code boxes and fields that ignore fill. For a code split into one box per digit, type the whole code once into the first box, and to correct it type it again. A file download, or a PDF a tab shows, is saved to Downloads and listed in downloads with its path; if its state is downloading, the file appears there when done. Prefer this over computer_act for web pages. If the result includes fallback:"computer_act", use computer_act instead.`,
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
                enum: [...BROWSER_ACT_KINDS],
              },
              ref: {
                type: "string",
                description: "Element ref from browser_snapshot. Optional for fill_card.",
              },
              text: {
                type: "string",
                description: "Text for fill or type (type replaces the field's text).",
              },
              paths: {
                type: "array",
                items: { type: "string" },
                description: "Files to attach, for upload.",
              },
              secret: {
                type: "string",
                description:
                  "Saved login name for fill_secret, or for fill_code to type that login's authenticator code.",
              },
              purchase: {
                type: "string",
                description: "Approved purchase id for fill_card or fill_pay_token.",
              },
              card: {
                type: "string",
                description: "Saved card for fill_card, with site; each call asks the user.",
              },
              site: {
                type: "string",
                description: "Checkout's HTTPS origin.",
              },
              field: {
                type: "string",
                description: `The login field's label for fill_secret (username and password also name a login's first visible and first hidden field); ${PURCHASE_CARD_FIELDS.join(", ")} for fill_card.`,
              },
            },
            required: ["kind"],
          },
        },
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
    description: `Read a UTF-8 text file from this bot's home. On a Team Computer, relative paths use the bot folder and shared/... accesses shared work. Open visual or binary files with open_path instead. Long files come back in line ranges; follow nextOffset. Over ${READ_FILE_MAX_KB} KB, use shell.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", description: "First line to read, 1-based." },
        limit: { type: "integer", description: "Maximum number of lines." },
      },
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
      "Attach a workspace file from this bot's home to the chat thread as an image or common file. The user sees it; you do not. The file stays in place; users can open it from the message and from the Artifacts tab. For a self-contained HTML page, document, or anything else meant to be viewed on its own — give it name and description: a title and a one-line summary. Skip them for an ordinary attachment like a log file or export. To UPDATE something you already made, call this again with the exact same name — it becomes a new version of that same artifact instead of a separate one; a different name always starts a new artifact.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "shell",
    description:
      "Run a command inside this bot's computer. cwd defaults to the bot's folder on a Team Computer and the workspace root on a Private Computer. Output can arrive while the command is still running; tell the user any one-time code or sign-in URL in that output. A command is stopped after a few minutes, so on Linux or macOS start longer work, such as a coding agent CLI, as its own statement `nohup <command> < /dev/null > <log> 2>&1 &`, never after `&&`, and read the log to follow it.",
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
    name: "user_computer_shell",
    description:
      "Run a command on the user's own computer. Use only when the task needs their local files, credentials, or network. cwd defaults to their home folder and must stay inside it.",
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
    name: "user_computer_observe",
    description:
      "Look at one app on the user's own computer without disturbing them: opens it in the background if needed and returns its window as numbered accessibility rows ([N]) and a screenshot. query narrows the rows. Use only when the task needs an app on their computer.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", minLength: 1, maxLength: 200 },
        query: { type: "string", maxLength: 200 },
      },
      required: ["app"],
    },
  },
  {
    name: "user_computer_act",
    description:
      'Act in one app on the user\'s own computer, in the background, and return its window afterwards. Observe it first. Up to 24 ordered actions: click (element, or x,y in screenshot pixels; button, double), type (text, into element or the focused field), set (value of element: a pop-up\'s choice, a field\'s whole text), key (key such as return, tab, escape, up, a; modifiers cmd, shift, option, ctrl), scroll (direction, amount, at element or x,y), menu (path from the menu bar, like ["File","New"]; use it instead of shortcuts), wait (ms). Element numbers come from the latest observation of that app.',
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", minLength: 1, maxLength: 200 },
        actions: {
          type: "array",
          minItems: 1,
          maxItems: 24,
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["click", "type", "set", "key", "scroll", "menu", "wait"],
              },
              element: { type: "integer", minimum: 0 },
              x: { type: "number" },
              y: { type: "number" },
              button: { type: "string", enum: ["left", "right"] },
              double: { type: "boolean" },
              text: { type: "string" },
              value: { type: "string" },
              key: { type: "string" },
              modifiers: {
                type: "array",
                items: { type: "string", enum: ["cmd", "shift", "option", "ctrl"] },
              },
              direction: { type: "string", enum: ["up", "down", "left", "right"] },
              amount: { type: "integer", minimum: 1, maximum: 20 },
              path: { type: "array", items: { type: "string" } },
              ms: { type: "integer", minimum: 0, maximum: 5000 },
            },
            required: ["kind"],
          },
        },
      },
      required: ["app", "actions"],
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
      "Launch an installed graphical application on this bot's computer, or raise its window if already open; optionally with a URI. Returns the resulting screen.",
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
      "Ask the user to take over the computer screen for CAPTCHA, payment, passkeys, or other protected input request_secret cannot take. Never ask the user to paste protected values in chat.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
  {
    name: "connect_app",
    description:
      "Show an inline card to connect an app in this chat when you need an unconnected app or the user asks to connect one. Then wait for the user instead of directing them elsewhere.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string", minLength: 1, maxLength: 100 } },
      required: ["app"],
      additionalProperties: false,
    },
  },
];
