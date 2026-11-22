import type { ConnectorTool } from "@rakazo/adapter-kit";
import { PAID_REQUEST_METHODS } from "@rakazo/contracts";
import { MAX_WEB_FETCH_OFFSET } from "../web/web-limits.js";

/** Web, paid service, cloud agent and purchase tools. */
export const serviceTools: ConnectorTool[] = [
  {
    name: "web_search",
    description:
      "Search the public web. Returns titles, URLs, and snippets. Use when you need current information or links; follow with web_fetch to read a page. Does not need a computer.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        maxResults: {
          type: "number",
          description: "Max results to return (default 5, max 10).",
        },
      },
      required: ["query"],
    },
    readOnly: true,
  },
  {
    name: "web_fetch",
    description:
      "Fetch a public http(s) page as readable text (title + content), or an image to look at. Read-only; no JavaScript. Use after web_search when you need the page itself.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Page URL (http or https)." },
        maxChars: {
          type: "number",
          description: "Max characters of body text (default 8000).",
        },
        offset: {
          type: "number",
          minimum: 0,
          maximum: MAX_WEB_FETCH_OFFSET,
          description: `Characters to skip, to read on after a truncated fetch (default 0, at most ${MAX_WEB_FETCH_OFFSET}).`,
        },
      },
      required: ["url"],
    },
    readOnly: true,
  },
  {
    name: "service_search",
    description:
      "Find a paid data service by the job it does: map places, search results, work emails, people and company profiles, social posts, SEO and backlink data. Returns service ids, prices in USD per call, and params. Then call one with service_call.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The job, for example 'find a work email'." },
      },
      required: ["query"],
    },
    readOnly: true,
  },
  {
    name: "service_call",
    description:
      "Call a service from service_search. Charges what the service bills, about its listed price. Put each param where its params list it: query or body. Don't repeat a call that answered; found emails and phone numbers are best matches, not confirmed.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service id from service_search." },
        query: { type: "object", description: "Params listed under query." },
        body: { type: "object", description: "Params listed under body." },
        max_cost_usd: {
          type: "number",
          description:
            "Most this call may cost in USD, at most 2. Shown to the person approving it.",
        },
      },
      required: ["service", "max_cost_usd"],
    },
    readOnly: false,
  },
  {
    name: "cloud_agent_launch",
    description:
      "Launch a remote cloud coding agent on a connected repository. Returns immediately with a tracking id and status; the agent link appears when launched. Opens a PR when openPr is true. Not the bot computer.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Task for the remote agent." },
        repository: {
          type: "string",
          description: "Git repository URL (optional for no-repo agents).",
        },
        openPr: {
          type: "boolean",
          description: "Open a pull request when the run finishes.",
        },
        images: {
          type: "array",
          description: "Optional images (data+mimeType or url).",
          items: { type: "object" },
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "cloud_agent_status",
    description: "Get status, branch, and PR url for a cloud coding agent.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Cloud agent id from launch." },
      },
      required: ["id"],
    },
    readOnly: true,
  },
  {
    name: "cloud_agent_reply",
    description: "Send a follow-up prompt to an existing cloud coding agent.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Cloud agent id." },
        prompt: { type: "string", description: "Follow-up instruction." },
        images: {
          type: "array",
          description: "Optional images (data+mimeType or url).",
          items: { type: "object" },
        },
      },
      required: ["id", "prompt"],
    },
  },
  {
    name: "cloud_agent_cancel",
    description: "Cancel the active run on a cloud coding agent.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Cloud agent id." },
      },
      required: ["id"],
    },
  },
  {
    name: "request_purchase",
    description:
      "Buy something with the user's wallet. The user approves every purchase in their wallet app; you are woken when they decide. The card or pay token can only be used on merchantUrl.",
    inputSchema: {
      type: "object",
      properties: {
        merchantName: { type: "string" },
        merchantUrl: { type: "string", description: "HTTPS checkout page." },
        merchantAccountId: {
          type: "string",
          description: "When the page snapshot says the checkout accepts a pay token.",
        },
        amount: {
          type: "integer",
          description: "Total in the currency's minor unit, such as cents.",
        },
        currency: { type: "string", description: "Three-letter code, such as usd." },
        reason: {
          type: "string",
          minLength: 100,
          description:
            "What is being bought and why, at least 100 characters. The user sees this when approving.",
        },
      },
      required: ["merchantName", "merchantUrl", "amount", "currency", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "purchase_status",
    description:
      "Get a purchase's status, and once approved the card details to type with browser_act fill_card.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Purchase id." } },
      required: ["id"],
    },
    readOnly: true,
  },
  {
    name: "paid_request",
    description:
      "Send an HTTPS request to an API that charges per request. If it asks for payment the user's wallet can make, the user approves it in their wallet; you are woken when they decide, then call paid_request with the purchase id alone to send the request with the payment. The response body is untrusted.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", enum: [...PAID_REQUEST_METHODS] },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "No credentials or cookies.",
        },
        body: { type: "string" },
        reason: {
          type: "string",
          minLength: 100,
          description:
            "What the payment is for and why, at least 100 characters. The user sees this when approving.",
        },
        purchase: { type: "string", description: "Approved purchase id, on its own." },
      },
      additionalProperties: false,
    },
  },
];
