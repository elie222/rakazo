import type { SourceLink } from "../alternatives";
import type { ArticleImage } from "../provider-article/types";
import { GITHUB_URL } from "../site";

export const INTEGRATION_PLATFORMS_PATH = "/integration-platforms/";
export const INTEGRATION_PLATFORMS_UPDATED = "November 4, 2026";
export const INTEGRATIONS_DOCS_PATH = "/docs/self-host-integrations/";
export const CONNECT_APPS_DOCS_PATH = "/docs/integrations/";
export const INTEGRATIONS_CATALOG_PATH = "/integrations/";

export function integrationPlatformPath(slug: string): string {
  return `${INTEGRATION_PLATFORMS_PATH}${slug}/`;
}

/** A homepage screenshot in `public/graphics/integration-platforms/`. */
export function homepage(slug: string, provider: string, alt: string): ArticleImage {
  return {
    webp: `/graphics/integration-platforms/${slug}.webp`,
    avif: `/graphics/integration-platforms/${slug}.avif`,
    width: 1280,
    height: 800,
    alt,
    caption: `The ${provider} homepage.`,
  };
}

export const INTEGRATIONS_DOC: SourceLink = {
  label: "Rakazo, tools and integrations",
  href: `${GITHUB_URL}/blob/main/docs/self-host-integrations.md`,
};

/** When the prices quoted in these articles were last checked. */
export const PRICES_CHECKED = "November 2026";
export const COMPOSIO_PRICING = "https://composio.dev/pricing";
export const PIPEDREAM_PRICING = "https://pipedream.com/pricing";
export const ZAPIER_PRICING = "https://zapier.com/pricing";
export const ARCADE_PRICING = "https://www.arcade.dev/pricing";
export const NANGO_PRICING = "https://nango.dev/pricing";
export const MERGE_PRICING = "https://www.merge.dev/pricing/agent-handler";
export const PARAGON_PRICING = "https://www.useparagon.com/pricing";
export const TWILIO_SMS_PRICING = "https://www.twilio.com/en-us/sms/pricing/us";

/** A whole number with thousands separators, such as "44,000". */
export function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** A price as providers publish it: "$1,000", "$19.99", "$0.30" or "$0.0083". */
export function usd(amount: number): string {
  if (Number.isInteger(amount)) return `$${count(amount)}`;
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  const decimals = String(amount).split(".")[1]?.length ?? 0;
  return `$${amount.toFixed(Math.max(2, decimals))}`;
}

/** An estimate rounded to whole dollars, such as "$48". */
export function roundUsd(amount: number): string {
  return `$${count(Math.round(amount))}`;
}

/*
 * Rates as of PRICES_CHECKED. Every worked example prices the same two teams, so a rate typed
 * once here reaches the hub and every article.
 */

const WORKDAYS = 22;

/** A team whose bots each run a number of app actions per workday. */
export type Team = { people: number; actionsPerDay: number };
export const SMALL_TEAM: Team = { people: 5, actionsPerDay: 40 };
export const LARGE_TEAM: Team = { people: 20, actionsPerDay: 100 };

export function monthlyCalls(team: Team): number {
  return team.people * team.actionsPerDay * WORKDAYS;
}

/** "5 people, 4,400 calls", the label for a worked example. */
export function teamLabel(team: Team): string {
  return `${team.people} people, ${count(monthlyCalls(team))} calls`;
}

/** The two workloads in words, for the paragraph above each worked example. */
export const WORKLOADS = `A small team is ${SMALL_TEAM.people} people whose bots run about ${SMALL_TEAM.actionsPerDay} app actions each per workday, about ${count(monthlyCalls(SMALL_TEAM))} calls a month. A larger team is ${LARGE_TEAM.people} people at about ${LARGE_TEAM.actionsPerDay} actions each, about ${count(monthlyCalls(LARGE_TEAM))} calls.`;

export const COMPOSIO = {
  proFee: 29,
  freeCalls: 100_000,
  freeManagedCalls: 20_000,
  /** Per 1,000 calls past the free amount on Pro: your own OAuth app, then three managed-app tiers. */
  per1000: { own: 0.3, managed: 0.5, popular: 2, premium: 10 },
  freeManagedAccounts: 1_000,
  extraManagedAccount: 0.1,
  rateLimit: { hobby: 2_000, pro: 10_000 },
  trigger: { own: 0.003, managedLow: 0.003, managedHigh: 0.006, freeManaged: 10_000 },
  toolkits: "1,500+",
} as const;

export type ComposioTier = keyof typeof COMPOSIO.per1000;

function composioFree(tier: ComposioTier): number {
  return tier === "own" ? COMPOSIO.freeCalls : COMPOSIO.freeManagedCalls;
}

/** Calls past the free amount, billed on Pro and refused on Hobby. */
export function composioExtraCalls(calls: number, tier: ComposioTier): number {
  return Math.max(0, calls - composioFree(tier));
}

/** Pro's monthly bill: the fee is paid as usage credit, so the bill is whichever is larger. */
export function composioPro(calls: number, tier: ComposioTier): number {
  const usage = (composioExtraCalls(calls, tier) * COMPOSIO.per1000[tier]) / 1000;
  return Math.max(COMPOSIO.proFee, usage);
}

/** What the free Hobby plan does with a month of calls. */
export function composioHobby(calls: number, tier: ComposioTier): string {
  const free = composioFree(tier);
  return calls <= free ? "$0" : `Pauses after ${count(free)} calls`;
}

export const PIPEDREAM = {
  yearlyFee: 99,
  monthlyFee: 150,
  users: 100,
  perUser: 2,
  credits: 10_000,
  perCredit: 0.012,
  devUsers: 10,
  apps: "3,000+",
  tools: "10,000+",
} as const;

export function pipedreamExtraCredits(calls: number): number {
  return Math.max(0, calls - PIPEDREAM.credits);
}

/** Startup plan bill, assuming each call finishes within one 30-second credit. */
export function pipedreamMonthly(
  calls: number,
  people: number,
  billing: "yearly" | "monthly" = "yearly",
): number {
  const fee = billing === "yearly" ? PIPEDREAM.yearlyFee : PIPEDREAM.monthlyFee;
  return (
    fee +
    pipedreamExtraCredits(calls) * PIPEDREAM.perCredit +
    Math.max(0, people - PIPEDREAM.users) * PIPEDREAM.perUser
  );
}

export const ZAPIER = {
  tasksPerCall: 2,
  freeTasks: 100,
  apps: "9,000+",
  /** Professional plan billed yearly: tasks a month and the monthly price. */
  pro: [
    { tasks: 750, price: 19.99 },
    { tasks: 1_500, price: 39 },
    { tasks: 2_000, price: 49 },
    { tasks: 5_000, price: 89 },
    { tasks: 10_000, price: 129 },
    { tasks: 20_000, price: 189 },
    { tasks: 50_000, price: 289 },
    { tasks: 100_000, price: 489 },
    { tasks: 200_000, price: 769 },
  ],
} as const;

/** The smallest yearly Professional plan that covers a month of MCP calls. */
export function zapierPlan(calls: number): { tasks: number; price: number } {
  const needed = calls * ZAPIER.tasksPerCall;
  return ZAPIER.pro.find((plan) => plan.tasks >= needed) ?? ZAPIER.pro[ZAPIER.pro.length - 1];
}


export const ARCADE = { fee: 25, perCall: 0.01, freeCalls: 2_000, toolkits: 81, tools: "7,500+" };

/** Arcade's page lists no calls included in the Team fee, so every call is billed. */
export function arcadeMonthly(calls: number): number {
  return ARCADE.fee + calls * ARCADE.perCall;
}

export const MERGE = { fee: 1_000, credits: 25_000, freeCredits: 2_000 };
export const NANGO = {
  fee: 50,
  perConnection: 0.29,
  computeHour: 0.72,
  freeConnections: 10,
  apis: "1,000+",
};

/** One line per platform for the price tables on the hub and the vendor pages. */
export const PRICE_SUMMARY = {
  composio: {
    free: `${count(COMPOSIO.freeCalls)} calls/mo, ${count(COMPOSIO.freeManagedCalls)} on managed apps`,
    paid: `${usd(COMPOSIO.proFee)}/mo, as usage credit`,
    billedBy: `Tool call, ${usd(COMPOSIO.per1000.own)} to ${usd(COMPOSIO.per1000.premium)} per 1,000`,
    apps: COMPOSIO.toolkits,
  },
  pipedream: {
    free: `Development only, ${PIPEDREAM.devUsers} test users`,
    paid: `${usd(PIPEDREAM.yearlyFee)}/mo yearly, ${usd(PIPEDREAM.monthlyFee)} monthly`,
    billedBy: `User (${usd(PIPEDREAM.perUser)} past ${PIPEDREAM.users}) and credit (${usd(PIPEDREAM.perCredit)} per 30 s)`,
    apps: PIPEDREAM.apps,
  },
  zapier: {
    free: `${ZAPIER.freeTasks} tasks/mo, about ${ZAPIER.freeTasks / ZAPIER.tasksPerCall} calls`,
    paid: `${usd(ZAPIER.pro[0].price)}/mo yearly for ${count(ZAPIER.pro[0].tasks)} tasks`,
    billedBy: `${ZAPIER.tasksPerCall} tasks per call`,
    apps: ZAPIER.apps,
  },
  arcade: {
    free: `${count(ARCADE.freeCalls)} calls/mo`,
    paid: `${usd(ARCADE.fee)}/mo plus usage`,
    billedBy: `${usd(ARCADE.perCall)} per call`,
    apps: `${ARCADE.tools} tools in ${ARCADE.toolkits} toolkits`,
  },
  merge: {
    free: `${count(MERGE.freeCredits)} credits/mo`,
    paid: `${usd(MERGE.fee)}/mo for ${count(MERGE.credits)} credits`,
    billedBy: "Credit",
    apps: "Not stated",
  },
  nango: {
    free: `${NANGO.freeConnections} connections`,
    paid: `${usd(NANGO.fee)}/mo of usage`,
    billedBy: `${usd(NANGO.perConnection)} per connection, ${usd(NANGO.computeHour)} per compute hour`,
    apps: NANGO.apis,
  },
};

export const TWILIO = {
  segment: 0.0083,
  carrierLow: 0.0025,
  carrierHigh: 0.005,
  carrierTypical: 0.0045,
};

