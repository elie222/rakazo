import {
  BYOK_ANNUAL_PRICE_CENTS,
  BYOK_MONTHLY_PRICE_CENTS,
  MODEL_CREDIT_AMOUNTS,
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

export type PricingPlan = {
  name: string;
  price: string;
  note?: string;
  features: string[];
  action: { label: string; href: string };
};

/** Prices come from the same constants the app bills with. */
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
    price: BYOK_MONTHLY_PRICE_CENTS === null ? "Free" : `${dollars(BYOK_MONTHLY_PRICE_CENTS)}/mo`,
    note:
      BYOK_ANNUAL_PRICE_CENTS === null
        ? undefined
        : `${dollars(BYOK_ANNUAL_PRICE_CENTS / 12)}/mo billed yearly`,
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
    note: "Paid as model credits",
    features: [
      "Hosted by us",
      "No model account needed",
      "Cloud computer included",
      "Top up any time",
    ],
    action: { label: "Get started", href: APP_URL },
  },
];

export const PRICING_MARKDOWN = `# Rakazo pricing

${PRICING_PLANS.map(
  (plan) => `## ${plan.name}

${plan.price}${plan.note ? ` (${plan.note})` : ""}

${plan.features.map((feature) => `- ${feature}`).join("\n")}

[${plan.action.label}](${new URL(plan.action.href, "https://rakazo.com").href})`,
).join("\n\n")}
`;
