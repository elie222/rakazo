import { GITHUB_URL } from "../site";
import {
  COMPOSIO,
  INTEGRATIONS_DOC,
  PIPEDREAM,
  PRICES_CHECKED,
  TWILIO,
  TWILIO_SMS_PRICING,
  homepage,
  usd,
} from "./shared";

/** Texts a month in the Twilio example. */
const REMINDERS = 300;
import type { IntegrationPlatform } from "./types";

export const apiConnectors: IntegrationPlatform = {
  slug: "api-connectors",
  name: "API connectors",
  gives: "One tool per operation in an OpenAPI or GraphQL API",
  logins: "Your API key or token, encrypted in Rakazo",
  bestFor: "APIs with a key and no MCP server",
  title: "API connectors for AI agents: turn OpenAPI and GraphQL APIs into tools, and what they cost",
  description:
    "How Rakazo turns an OpenAPI description or a GraphQL endpoint into tools for AI agents, what calling a third-party API really costs, how it compares with MCP and Composio, and how integrations.sh helps find an app's API.",
  h1: "Turn any OpenAPI or GraphQL API into tools for your AI agents",
  intro: [
    "Many apps have an API but no MCP server and no ready-made integration. An API connector closes that gap: point it at the API's [OpenAPI](https://www.openapis.org) description or GraphQL endpoint, and each operation becomes a tool an AI agent can call. There is no platform fee in the middle: you pay only what the API itself charges. [integrations.sh](https://integrations.sh) is an open source catalog that helps you find those descriptions.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, bots use tools in your apps, and each bot also has its own computer. You can use it on Rakazo Cloud or host it yourself. API connectors let your bots use apps that aren't in the [integrations catalog](/integrations/), with only an API key.",
  ],
  scene: {
    bot: "Account Manager",
    color: "#9B5CF6",
    where: "Tools from an OpenAPI connector",
    ask: "who renews this month and hasn't logged in for two weeks?",
    reply: "four accounts. pulled from the billing api, list below.",
    results: [
      { k: "Called", v: "listSubscriptions · getUsage" },
      { k: "Renewing", v: "11 accounts this month" },
      { k: "At risk", v: "4 · no logins in 14 days" },
    ],
  },
  sections: [
    {
      heading: "What is an API connector?",
      paragraphs: [
        "An OpenAPI document lists a REST API's operations, their parameters and the shape of each request. A GraphQL API describes its own schema when asked, through introspection. An API connector reads that description and turns each operation into a tool, so an agent can call the API without anyone writing code for it.",
        "[integrations.sh](https://integrations.sh) is an [open source](https://github.com/UsefulSoftwareCo/integrations) registry of the ways agents can reach a service: MCP servers, OpenAPI descriptions, GraphQL endpoints and command-line tools, grouped by domain, with notes on how each signs in. Services list themselves by publishing a `/.well-known/integrations.json` file.",
      ],
      image: true,
    },
    {
      heading: "What bots can do with API connectors in Rakazo",
      bullets: [
        "Use a REST API from its OpenAPI description. Paste the document's URL, in JSON or YAML, and Rakazo turns every operation with an `operationId` into a tool, up to 100 per API.",
        "Use a GraphQL API from its endpoint. Rakazo introspects the schema and turns queries and mutations into tools, up to 100 per API.",
        "Authenticate with a bearer token or an API key header. The key is encrypted, never sent to the model, and removed from what the API sends back.",
        "Find an API by domain. When the operator points `INTEGRATIONS_CATALOG_URL` at an integrations.sh-compatible catalog, **Search by domain** adds a service's OpenAPI description or MCP server with the address and sign-in method filled in.",
        "Read without asking. A `GET` operation or a GraphQL query counts as reading, so in **Ask** mode it usually runs without a card. Writes ask first, under your [approval settings](/docs/approvals/).",
        "Share it. Every bot in the [spaces](/docs/spaces/) you choose can use the connector. API connectors share one tool count with the MCP servers installed from **Integrations**: past 20 tools in total, a bot searches for the operations it needs instead of loading them all.",
      ],
    },
    {
      heading: "What API connectors cost",
      paragraphs: [
        "Rakazo adds nothing per call: API connectors are part of every plan on Rakazo Cloud and free when you host Rakazo yourself. integrations.sh is free and open source. The cost is whatever the API's owner charges for the calls your bot makes, under your own account and key, and it comes in three shapes.",
        "Many business apps include API access in the plan you already pay for and limit how fast you can call it. Some services charge for each request or for what the request does, such as sending a text message. And your own company's APIs cost only the servers they run on. Either way the bill comes from the API's owner, on the terms of your account with them.",
      ],
      table: {
        caption: "What a bot's API calls cost, by example",
        columns: ["API", "What the API costs", "Limits that matter for a bot"],
        rows: [
          {
            topic: "GitHub REST API",
            cells: ["Included with any GitHub account", "5,000 requests an hour with a personal access token"],
          },
          {
            topic: "HubSpot API",
            cells: [
              "Included in every HubSpot plan, Free included",
              "100 requests per 10 seconds and 250,000 a day on Free and Starter; 190 and 625,000 on Professional",
            ],
          },
          {
            topic: "Twilio SMS",
            cells: [
              `${usd(TWILIO.segment)} per US message segment, plus a carrier fee of ${usd(TWILIO.carrierLow)} to ${usd(TWILIO.carrierHigh)}`,
              "Business texting in the US needs A2P 10DLC registration first",
            ],
          },
          {
            topic: "Your own API",
            cells: ["Your hosting", "Whatever you set"],
          },
        ],
        note: `From [GitHub's rate limit docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [HubSpot's usage guidelines](https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines) and [Twilio's US SMS pricing](${TWILIO_SMS_PRICING}), checked ${PRICES_CHECKED}.`,
      },
      bullets: [
        `A worked example: a bot that texts ${REMINDERS} appointment reminders a month through Twilio spends about ${REMINDERS} × (${usd(TWILIO.segment)} + ${usd(TWILIO.carrierTypical)}) ≈ ${usd(Number((REMINDERS * (TWILIO.segment + TWILIO.carrierTypical)).toFixed(2)))}, plus the phone number's monthly fee. The same bot reading 2,000 HubSpot records a month costs nothing beyond your HubSpot plan, well inside its limits.`,
        "The cost people miss is model tokens. Every response an API sends back goes into the bot's context and is billed as input by your model provider. Rakazo cuts responses at 1 MB, but asking for only the fields you need, through an operation's filters, saves more.",
        "Rate limits belong to your account or key, so several bots sharing one key share one limit. A bot that hits a limit gets the API's error and can wait and try again.",
        `Compared with a hosted platform: [Composio](/integration-platforms/composio/) charges from ${usd(COMPOSIO.per1000.own)} to ${usd(COMPOSIO.per1000.premium)} per 1,000 calls past its free tier and [Pipedream Connect](/integration-platforms/pipedream/) starts at ${usd(PIPEDREAM.yearlyFee)} a month, on top of the same API limits. An API connector skips that layer when a key is all you need.`,
      ],
    },
    {
      heading: "API connector vs MCP server vs a hosted platform",
      table: {
        caption: "Three ways to give a bot tools for an app",
        columns: ["Compared", "API connector", "MCP server", "Composio or Pipedream"],
        rows: [
          {
            topic: "Who writes the tools",
            cells: ["Generated from the API's description", "The app's team or whoever runs the server", "The platform"],
          },
          {
            topic: "Sign-in",
            cells: ["API key or token", "OAuth, token or header", "Managed OAuth"],
          },
          {
            topic: "Cost on top of the app",
            cells: ["None", "None for an app's own server", "Per call, credit or user"],
          },
          {
            topic: "Where logins live",
            cells: ["Encrypted in Rakazo", "Encrypted in Rakazo", "With the platform"],
          },
          {
            topic: "Tool quality",
            cells: ["As good as the API's descriptions", "Usually written for agents", "Written for agents"],
          },
          {
            topic: "Best for",
            cells: ["APIs with a key and no MCP server, and your own APIs", "Apps that publish a server", "Apps that need OAuth and have no server"],
          },
        ],
      },
    },
    {
      heading: "When to choose API connectors",
      paragraphs: [
        "Choose an API connector when an app has a documented API and an API key, but no MCP server and no integration in the catalog. That covers many smaller SaaS tools and your company's own APIs, and needs no other service.",
        "If the app publishes an [MCP server](/integration-platforms/mcp/), use that instead: its tools are written for agents and it can sign you in with OAuth. If the app needs an OAuth sign-in and has no MCP server, [Composio](/integration-platforms/composio/) or [Pipedream](/integration-platforms/pipedream/) handle that for you. The [comparison](/integration-platforms/) covers all four.",
      ],
    },
    {
      heading: "Limits and security",
      bullets: [
        "There is no OAuth sign-in for API connectors. Use an API key or a long-lived token; a token that expires has to be replaced by hand.",
        "An OpenAPI document must list a server URL, give operations an `operationId` and be under 2 MB. Only the first 100 operations are imported, and request bodies are JSON.",
        "A GraphQL API must allow introspection. Larger schemas are cut to 100 operations, split between queries and mutations.",
        "APIs must be at public addresses. Localhost and private networks are refused unless the operator sets `MCP_ALLOW_PRIVATE_ENDPOINT=true` on the API and worker, which allows them for every user. Cloud metadata addresses stay blocked.",
        "The Settings form sends a key as a bearer token or a header. Connectors installed through Rakazo's API can also put it in the URL as a query parameter, so avoid that for sensitive keys. Redirects aren't followed, each call has 30 seconds and responses over 1 MB are cut short.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "Anyone with an account can add an API connector, on Rakazo Cloud or a self-hosted server. The catalog search is an optional setting for the admin of a [self-hosted Rakazo](/self-hosted-ai-agent/). See [Connect apps](/docs/integrations/) and the [tools and integrations guide](/docs/self-host-integrations/).",
      ],
      steps: [
        "Find the API's OpenAPI document or GraphQL endpoint in its developer docs or on [integrations.sh](https://integrations.sh).",
        "Open **Integrations** from **Connect apps** at the bottom of the sidebar, choose **+**, then **OpenAPI** or **GraphQL**.",
        "Paste the URL, choose **No auth**, **Bearer token** or **API key header**, enter the key, and choose **Verify and add**.",
        "Ask a bot to use the API, and approve any call that changes something.",
        "Optionally, an admin sets `INTEGRATIONS_CATALOG_URL` on the API to `https://integrations.sh` or a compatible mirror to turn on **Search by domain**.",
      ],
    },
  ],
  image: homepage(
    "api-connectors",
    "integrations.sh",
    "The integrations.sh homepage, headed Every integration, in every format agents speak.",
  ),
  faq: [
    {
      question: "Can an AI agent use any REST API?",
      answer:
        "Any that has an OpenAPI description: Rakazo turns each operation into a tool. For an API without one, ask the bot to save your key as a [reusable credential](/docs/bot-secrets/), and it can call the API without ever seeing the key.",
    },
    {
      question: "What is integrations.sh?",
      answer:
        "An open source catalog of the MCP servers, OpenAPI descriptions, GraphQL APIs and command-line tools that services offer, grouped by domain. Rakazo searches it to find an app's MCP server, and can search it or a mirror to find an app's API.",
    },
    {
      question: "Should I use an API connector or an MCP server?",
      answer:
        "Use the app's [MCP server](/integration-platforms/mcp/) when it has one. Its tools are designed for agents and it supports OAuth. Use an API connector when the app only offers an API and a key.",
    },
    {
      question: "How much does it cost to connect an AI agent to an API?",
      answer:
        "Rakazo charges nothing per call. You pay the API's own price under your account, which for many business apps is included in your plan with a rate limit, and for metered services such as SMS or search is a price per request. The bot's model tokens for reading the responses are billed by your model provider.",
    },
    {
      question: "Does the model see my API key?",
      answer:
        "No. Rakazo stores the key encrypted, adds it to each request itself, and removes it from responses before the bot sees them.",
    },
  ],
  sources: [
    { label: "integrations.sh", href: "https://integrations.sh" },
    {
      label: "integrations.sh on GitHub",
      href: "https://github.com/UsefulSoftwareCo/integrations",
    },
    { label: "integrations.sh, publishing a service", href: "https://integrations.sh/publishing/" },
    { label: "OpenAPI Initiative", href: "https://www.openapis.org" },
    { label: "GraphQL, introspection", href: "https://graphql.org/learn/introspection/" },
    {
      label: "GitHub, REST API rate limits",
      href: "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api",
    },
    {
      label: "HubSpot, API usage guidelines",
      href: "https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines",
    },
    { label: "Twilio, US SMS pricing", href: TWILIO_SMS_PRICING },
    INTEGRATIONS_DOC,
    { label: "Rakazo, connect apps", href: `${GITHUB_URL}/blob/main/docs/integrations.md` },
  ],
};
