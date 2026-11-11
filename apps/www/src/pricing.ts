import type { ByokTier, ComputerSize, SandboxKind } from "@rakazo/contracts";
import {
  BYOK_TIERS,
  byokTierPriceCents,
  COMPUTER_SIZE_SPECS,
  CREDITS_SANDBOX_ALLOWANCE_PERCENT,
  DEFAULT_MONTHLY_CREDIT_AMOUNT,
  MODEL_CREDIT_AMOUNTS,
  sandboxAllowanceHours,
  TRIAL_DAYS,
  TRIAL_SANDBOX_ALLOWANCE_CENTS,
} from "@rakazo/contracts";
import { APP_URL, SELF_HOST_GUIDE_PATH } from "./site";

/** Whole dollars when the amount is round ("$15"), otherwise cents ("$12.50"). */
function dollars(cents: number) {
  const rounded = Math.round(cents);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: rounded % 100 === 0 ? 0 : 2,
  }).format(rounded / 100);
}

const STANDARD = BYOK_TIERS.standard;

export type PricingPlan = {
  name: string;
  price: string;
  note?: string;
  features: string[];
  action: { label: string; href: string };
};

/** Whole bot computer hours an allowance in cents buys. */
function computerHours(cents: number) {
  return Math.floor(sandboxAllowanceHours(cents));
}

/** What each computer size is good for, in plain words. */
const COMPUTER_USE: Record<ComputerSize, string> = {
  standard: "everyday coding and browsing",
  large: "faster builds and tests",
  xlarge: "big builds and many apps at once",
};

/** The exact hours and size behind a computer cell, shown on hover. */
function computerDetail(hours: string, size: ComputerSize) {
  const specs = COMPUTER_SIZE_SPECS[size];
  return `${hours} a month, ${specs.vcpus} vCPU, ${specs.memoryGb} GB RAM: ${COMPUTER_USE[size]}`;
}

/** Ends each computer hover, so the hours don't read as a meter on everything a bot does. */
const COMPUTER_TIME_NOTE =
  "Counts only while your bot uses its computer, which most work doesn't need. It pauses when idle.";

/** Computer hours a monthly credit plan of `cents` includes. */
function creditPlanHours(cents: number) {
  return computerHours((cents * CREDITS_SANDBOX_ALLOWANCE_PERCENT) / 100);
}

/** Display names for every sandbox a self-hosted deployment can use; typed so a new kind must be named. */
const SANDBOX_NAMES: Record<Exclude<SandboxKind, "none" | "desktop" | "fake">, string> = {
  docker: "Docker",
  kubernetes: "Kubernetes",
  incus: "Incus",
  boat: "Boat",
  boxd: "Boxd",
  createos: "CreateOS",
  daytona: "Daytona",
  e2b: "E2B",
  instabox: "InstaBox",
  novita: "Novita",
  railway: "Railway",
  wuying: "Wuying",
};
const SANDBOX_PROVIDERS = Object.values(SANDBOX_NAMES);

const CREDITS_PRICE = `From ${dollars(MODEL_CREDIT_AMOUNTS[0])}/mo`;

const SELF_HOSTED_PLAN: PricingPlan = {
  name: "Self-hosted",
  price: "Free",
  features: [
    "Open source, Apache-2.0",
    "Your server or your own computer",
    "Bot computers in Docker or a sandbox",
    "Any model you connect",
  ],
  action: { label: "Self-hosting guide", href: SELF_HOST_GUIDE_PATH },
};

const OWN_MODEL_PLAN: PricingPlan = {
  name: "Your model",
  price:
    STANDARD.monthlyPriceCents === null ? "Free" : `${dollars(STANDARD.monthlyPriceCents)}/mo`,
  note:
    STANDARD.annualPriceCents === null
      ? undefined
      : `${dollars(STANDARD.annualPriceCents / 12)}/mo billed yearly`,
  features: [
    "Hosted by us",
    "Claude, ChatGPT, or any API key",
    "Bot computer included",
    `${TRIAL_DAYS}-day free trial`,
  ],
  action: { label: "Start free trial", href: APP_URL },
};

/** Prices come from the same constants the app bills with. */
export const PRICING_PLANS: PricingPlan[] = [SELF_HOSTED_PLAN, OWN_MODEL_PLAN];

/** The less common hosted option, shown below the main plans. */
export const CREDITS_PLAN: PricingPlan = {
  name: "Rakazo credits",
  price: CREDITS_PRICE,
  note: "Model usage with no markup, plus computer hours",
  features: [
    "Hosted by us",
    "No model account needed",
    "Model usage at the provider's price, no markup",
    "Bot computer hours included",
    "Top up any time",
  ],
  action: { label: "Get started", href: APP_URL },
};

/** A comparison cell: included, not included, or a short value with optional detail on hover. */
export type PricingCell = boolean | string | { label: string; detail: string };

/** Own-model tiers on offer, from the terms the app bills with. */
const TIERS = (Object.keys(BYOK_TIERS) as ByokTier[]).flatMap((tier) => {
  const monthly = byokTierPriceCents(tier, "month");
  // A null Standard price makes the own-model plan free and hides the other tiers.
  if (monthly === null && tier !== "standard") return [];
  const terms = BYOK_TIERS[tier];
  return [
    {
      name: terms.name,
      price: monthly === null ? "Free" : `${dollars(monthly)}/mo`,
      computerSize: terms.computerSize,
      hours: computerHours(terms.computerAllowanceCents),
    },
  ];
});

const STANDARD_HOURS = computerHours(STANDARD.computerAllowanceCents);
const STANDARD_VCPUS = COMPUTER_SIZE_SPECS[STANDARD.computerSize].vcpus;

/** A tier's computer as a multiple of Standard's, so the table compares plans without a meter. */
function tierComputerCell(tier: (typeof TIERS)[number]): PricingCell {
  const usage = tier.hours / STANDARD_HOURS;
  const power = COMPUTER_SIZE_SPECS[tier.computerSize].vcpus / STANDARD_VCPUS;
  return {
    label: usage === 1 ? "Included" : `${usage}× the usage\n${power}× the power`,
    detail: `${computerDetail(`${tier.hours} hours`, tier.computerSize)}. ${COMPUTER_TIME_NOTE}`,
  };
}

const COLUMN_COUNT = TIERS.length + 2;
const included = (cell: PricingCell): PricingCell[] => Array(COLUMN_COUNT).fill(cell);

export const PRICING_COMPARISON = {
  // Short button labels so they fit the narrow columns.
  columns: [
    {
      name: SELF_HOSTED_PLAN.name,
      price: SELF_HOSTED_PLAN.price,
      action: { ...SELF_HOSTED_PLAN.action, label: "Self-host" },
    },
    ...TIERS.map((tier) => ({
      name: tier.name,
      price: tier.price,
      action: { ...OWN_MODEL_PLAN.action, label: "Start trial", ariaLabel: `Start ${tier.name} trial` },
    })),
    { name: CREDITS_PLAN.name, price: CREDITS_PRICE, action: CREDITS_PLAN.action },
  ],
  /** Most important first: what sets Rakazo apart, then the limits. */
  rows: [
    {
      feature: "Any model",
      cells: [
        ...included(true).slice(1),
        { label: "Our catalog", detail: "Credits cover the models Rakazo offers" },
      ],
    },
    {
      feature: "Sandbox",
      cells: [
        {
          label: `Your computer or any of ${SANDBOX_PROVIDERS.length}`,
          detail: `Your own computer through the desktop app, or ${SANDBOX_PROVIDERS.join(", ")}`,
        },
        ...TIERS.map(() => "Included"),
        "Included",
      ],
    },
    {
      feature: "Model usage",
      cells: [
        "Unlimited",
        ...TIERS.map(() => "Unlimited"),
        { label: "Credits", detail: "Charged at the provider's price, with no markup" },
      ],
    },
    { feature: "Integrations and MCP", cells: included(true) },
    {
      feature: "Bot computer",
      hint: "A computer your bot can use to run code, edit files, and browse. Time only counts while it's on, and it sleeps when idle. Most tasks don't need one.",
      cells: [
        "Unlimited",
        ...TIERS.map(tierComputerCell),
        {
          label: "Included",
          detail: `${computerDetail(`From ${creditPlanHours(MODEL_CREDIT_AMOUNTS[0])} hours`, STANDARD.computerSize)}. Hours grow with your plan: ${dollars(DEFAULT_MONTHLY_CREDIT_AMOUNT)} a month includes ${creditPlanHours(DEFAULT_MONTHLY_CREDIT_AMOUNT)}. ${COMPUTER_TIME_NOTE}`,
        },
      ],
    },
    { feature: "EU hosting", cells: ["Your choice", ...TIERS.map(() => true), true] },
    {
      feature: "Free trial",
      cells: [
        false,
        ...TIERS.map(() => ({
          label: `${TRIAL_DAYS} days`,
          detail: `Includes ${computerHours(TRIAL_SANDBOX_ALLOWANCE_CENTS)} bot computer hours`,
        })),
        false,
      ],
    },
    { feature: "Open source", cells: included(true) },
  ] satisfies { feature: string; hint?: string; cells: PricingCell[] }[],
};

function markdownCell(cell: PricingCell) {
  if (cell === true) return "Yes";
  if (cell === false) return "—";
  return typeof cell === "string"
    ? cell.replaceAll("\n", ", ")
    : `${cell.label.replaceAll("\n", ", ")} (${cell.detail})`;
}

function planMarkdown(plan: PricingPlan) {
  return `## ${plan.name}

${plan.price}${plan.note ? ` (${plan.note})` : ""}

${plan.features.map((feature) => `- ${feature}`).join("\n")}

[${plan.action.label}](${new URL(plan.action.href, "https://rakazo.com").href})`;
}

export const PRICING_MARKDOWN = `# Rakazo pricing

${[...PRICING_PLANS, CREDITS_PLAN].map(planMarkdown).join("\n\n")}

## Compare plans

| | ${PRICING_COMPARISON.columns.map((column) => `${column.name} (${column.price})`).join(" | ")} |
| --- | ${PRICING_COMPARISON.columns.map(() => "---").join(" | ")} |
${PRICING_COMPARISON.rows.map((row) => `| ${"hint" in row ? `${row.feature} (${row.hint})` : row.feature} | ${row.cells.map(markdownCell).join(" | ")} |`).join("\n")}
`;
