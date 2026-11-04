import type { ByokTier, ComputerSize } from "@rakazo/contracts";
import {
  BYOK_TIERS,
  byokTierPriceCents,
  COMPUTER_SIZE_SPECS,
  CREDITS_SANDBOX_ALLOWANCE_PERCENT,
  MODEL_CREDIT_AMOUNTS,
  sandboxAllowanceHours,
  TRIAL_DAYS,
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

/** Prices come from the same constants the app bills with. */
/** Whole cloud computer hours an allowance in cents buys. */
function computerHours(cents: number) {
  return Math.floor(sandboxAllowanceHours(cents));
}

/** A computer size on two lines in the table; Markdown joins them. */
function computerSpecs(size: ComputerSize) {
  const specs = COMPUTER_SIZE_SPECS[size];
  return `${specs.vcpus} vCPU\n${specs.memoryGb} GB RAM`;
}

/** Hours a credit plan gets per dollar it costs. */
const CREDIT_HOURS_PER_DOLLAR = computerHours(CREDITS_SANDBOX_ALLOWANCE_PERCENT);

/** Hours on the smallest credit plan, matching its "From" price. */
const SMALLEST_CREDIT_PLAN_HOURS = computerHours(
  (MODEL_CREDIT_AMOUNTS[0] * CREDITS_SANDBOX_ALLOWANCE_PERCENT) / 100,
);

const SANDBOX_PROVIDERS = [
  "Docker",
  "Kubernetes",
  "Boat",
  "Boxd",
  "CreateOS",
  "Daytona",
  "E2B",
  "Novita",
  "Railway",
  "Wuying",
];

export const PRICING_PLANS: PricingPlan[] = [
  {
    name: "Self-hosted",
    price: "Free",
    features: [
      "Open source, Apache-2.0",
      "Your server or your own computer",
      "Bot computers in Docker or a sandbox",
      "Any model you connect",
    ],
    action: { label: "Self-hosting guide", href: SELF_HOST_GUIDE_PATH },
  },
  {
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
      "Cloud computer included",
      `${TRIAL_DAYS}-day free trial`,
    ],
    action: { label: "Start free trial", href: APP_URL },
  },
  {
    name: "Rakazo credits",
    price: `From ${dollars(MODEL_CREDIT_AMOUNTS[0])}/mo`,
    note: "Model usage included",
    features: [
      "Hosted by us",
      "No model account needed",
      "Cloud computer included",
      "Top up any time",
    ],
    action: { label: "Get started", href: APP_URL },
  },
];

/** A comparison cell: included, not included, or a short value with optional detail on hover. */
export type PricingCell = boolean | string | { label: string; detail: string };

const STANDARD_COMPUTER = computerSpecs(STANDARD.computerSize);

/** Own-model tiers on offer, from the terms the app bills with. */
const TIERS = (Object.keys(BYOK_TIERS) as ByokTier[]).flatMap((tier) => {
  const monthly = byokTierPriceCents(tier, "month");
  if (monthly === null) return [];
  const terms = BYOK_TIERS[tier];
  return [
    {
      name: terms.name,
      price: `${dollars(monthly)}/mo`,
      computer: computerSpecs(terms.computerSize),
      hours: computerHours(terms.computerAllowanceCents),
    },
  ];
});

const COLUMN_COUNT = TIERS.length + 2;
const included = (cell: PricingCell): PricingCell[] => Array(COLUMN_COUNT).fill(cell);

export const PRICING_COMPARISON = {
  columns: [
    { name: "Self-hosted", price: "Free" },
    ...TIERS.map((tier) => ({ name: tier.name, price: tier.price })),
    { name: "Rakazo credits", price: PRICING_PLANS[2]?.price ?? "" },
  ],
  /** Most important first: what sets Rakazo apart, then the limits. */
  rows: [
    { feature: "Any model", cells: included(true) },
    {
      feature: "Sandbox",
      cells: [
        {
          label: `Any of ${SANDBOX_PROVIDERS.length} providers`,
          detail: SANDBOX_PROVIDERS.join(", "),
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
    { feature: "Use your own computer", cells: included(true) },
    { feature: "Integrations and MCP", cells: included(true) },
    {
      feature: "Cloud computer hours",
      hint: "Counted only while a cloud computer runs.",
      cells: [
        "Unlimited",
        ...TIERS.map((tier) => `${tier.hours} hours/mo`),
        {
          label: `From ${SMALLEST_CREDIT_PLAN_HOURS} hours/mo`,
          detail: `${CREDIT_HOURS_PER_DOLLAR} hour a month for every $1 of your plan`,
        },
      ],
    },
    {
      feature: "Cloud computer",
      cells: ["Any size", ...TIERS.map((tier) => tier.computer), STANDARD_COMPUTER],
    },
    { feature: "Hosted in the EU", cells: [false, ...TIERS.map(() => true), true] },
    {
      feature: "Free trial",
      cells: [false, ...TIERS.map(() => `${TRIAL_DAYS} days`), false],
    },
    { feature: "Open source", cells: included(true) },
  ] satisfies { feature: string; hint?: string; cells: PricingCell[] }[],
};

function markdownCell(cell: PricingCell) {
  if (cell === true) return "Yes";
  if (cell === false) return "—";
  return typeof cell === "string" ? cell.replaceAll("\n", ", ") : `${cell.label} (${cell.detail})`;
}

function planMarkdown(plan: PricingPlan) {
  return `## ${plan.name}

${plan.price}${plan.note ? ` (${plan.note})` : ""}

${plan.features.map((feature) => `- ${feature}`).join("\n")}

[${plan.action.label}](${new URL(plan.action.href, "https://rakazo.com").href})`;
}

export const PRICING_MARKDOWN = `# Rakazo pricing

${PRICING_PLANS.map(planMarkdown).join("\n\n")}

## Compare plans

| | ${PRICING_COMPARISON.columns.map((column) => `${column.name} (${column.price})`).join(" | ")} |
| --- | ${PRICING_COMPARISON.columns.map(() => "---").join(" | ")} |
${PRICING_COMPARISON.rows.map((row) => `| ${"hint" in row ? `${row.feature} (${row.hint})` : row.feature} | ${row.cells.map(markdownCell).join(" | ")} |`).join("\n")}
`;
