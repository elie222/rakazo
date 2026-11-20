import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { BillingStatus, PlanLimits, UsageBreakdownInput } from "@rakazo/contracts";
import {
  captureScreenshot,
  chooseOption,
  completeOnboarding,
  openUserSettings,
  signup,
} from "../helpers/helpers";

const hours = (count: number) => new Date(Date.now() + count * 3_600_000).toISOString();

// Provider allowances are read with a real subscription sign-in, which e2e never has.
const plans: PlanLimits[] = [
  {
    credentialId: "claude",
    name: "Claude",
    label: "Claude",
    windows: [
      { period: "session", usedPercent: 38, resetsAt: hours(2.5) },
      { period: "week", usedPercent: 64, resetsAt: hours(80) },
    ],
  },
  {
    credentialId: "chatgpt",
    name: "ChatGPT",
    label: "work@example.com",
    windows: [
      { period: "session", usedPercent: 93, resetsAt: hours(0.4) },
      { period: "week", usedPercent: 21, resetsAt: hours(130) },
    ],
  },
];

// A full history, so the screenshot shows the breakdown under the allowances.
const summary = {
  runs: 42,
  inputTokens: 910_000,
  outputTokens: 86_000,
  totalTokens: 996_000,
  costUsd: 4.2,
  modelCalls: 180,
  incomplete: [],
  models: [
    {
      provider: "subscription",
      model: "example-large",
      inputTokens: 910_000,
      outputTokens: 86_000,
      totalTokens: 996_000,
      costUsd: 4.2,
      modelCalls: 180,
      incomplete: [],
    },
  ],
};

const breakdown = {
  range: "30d",
  bots: [
    {
      id: "bot-1",
      name: "Assistant",
      deleted: false,
      runs: 42,
      inputTokens: 910_000,
      outputTokens: 86_000,
      totalTokens: 996_000,
      costUsd: 4.2,
      modelCalls: 180,
      incomplete: [],
    },
  ],
  modelOptions: [{ provider: "subscription", model: "example-large" }],
  totals: {
    runs: 42,
    inputTokens: 910_000,
    outputTokens: 86_000,
    totalTokens: 996_000,
    costUsd: 4.2,
    modelCalls: 180,
    incomplete: [],
  },
  models: summary.models,
  overTimeUnit: "day",
  overTime: [
    {
      date: "2026-11-10",
      inputTokens: 310_000,
      outputTokens: 26_000,
      totalTokens: 336_000,
      costUsd: 1.4,
      modelCalls: 60,
      incomplete: [],
    },
    {
      date: "2026-11-11",
      inputTokens: 300_000,
      outputTokens: 30_000,
      totalTokens: 330_000,
      costUsd: 1.4,
      modelCalls: 60,
      incomplete: [],
    },
    {
      date: "2026-11-12",
      inputTokens: 300_000,
      outputTokens: 30_000,
      totalTokens: 330_000,
      costUsd: 1.4,
      modelCalls: 60,
      incomplete: [],
    },
  ],
};

async function enableBilling(route: Route, path: "me" | "bootstrap") {
  const response = await route.fetch();
  const body = (await response.json()) as { json?: Record<string, unknown> };
  const me = path === "me" ? body.json : (body.json?.me as Record<string, unknown> | undefined);
  if (me) me.billingEnabled = true;
  await route.fulfill({ response, json: body });
}

const creditStatus: BillingStatus = {
  access: true,
  canManage: true,
  trialAvailable: false,
  trialDays: 7,
  state: "active",
  price: null,
  seats: 1,
  trialEndsAt: null,
  currentPeriodEndsAt: null,
  cancelAtPeriodEnd: false,
  hasCustomer: true,
  funding: "credits",
  balanceUsd: 12.5,
};

test("account menu shows the usage hint and Usage shows allowances and credits only when present", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/usage/limits", (route) => route.fulfill({ json: { json: plans } }));
  await page.route("**/rpc/usage/summary", (route) => route.fulfill({ json: { json: summary } }));
  await page.route("**/rpc/usage/breakdown", (route) => {
    const { json: input } = route.request().postDataJSON() as { json: UsageBreakdownInput };
    const filtered = input.botId === "bot-1" && input.range === "7d";
    const point = breakdown.overTime[2]!;
    return route.fulfill({
      json: {
        json: {
          ...breakdown,
          range: input.range,
          ...(filtered
            ? {
                totals: { ...point, runs: 14 },
                models: [{ provider: "subscription", model: "example-large", ...point }],
                overTime: [point],
              }
            : {}),
        },
      },
    });
  });
  const stamp = Date.now();
  await signup(page, `usage-limits-${stamp}@rakazo.test`, "password12", "Usage limits");
  await completeOnboarding(page);

  await page.getByTestId("user-menu-trigger").click();
  const usage = page.getByRole("button", { name: /^Usage/ });
  // ChatGPT is nearly out for this session, but Claude still has room.
  await expect(usage).toContainText("64% used");
  await captureScreenshot(page, testInfo, "usage-limits-account-menu");

  await usage.click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toHaveAttribute("data-settings-section", "usage");
  const cards = settings.getByTestId("plan-limits");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("Claude");
  await expect(cards.first().getByRole("progressbar", { name: "Weekly" })).toHaveAttribute(
    "aria-valuenow",
    "64",
  );
  await expect(cards.nth(1)).toContainText("work@example.com");
  await expect(settings.getByTestId("credit-balance")).toHaveCount(0);
  await expect(settings.getByRole("cell", { name: /example-large/ })).toBeVisible();
  const botFilter = settings.getByRole("combobox", { name: "Bot" });
  await expect(botFilter).toHaveText("All bots");
  await botFilter.click();
  await expect(page.getByRole("option")).toHaveText(["All bots", "Assistant"]);
  await page.keyboard.press("Escape");
  await expect(settings.getByRole("button", { name: "30 days" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(settings.getByText("Usage over time")).toBeVisible();
  await captureScreenshot(page, testInfo, "usage-limits-settings");

  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/rpc/usage/breakdown")) requests.push(request.postData() ?? "");
  });
  await chooseOption(botFilter, "Assistant");
  await settings.getByRole("button", { name: "7 days" }).click();
  await expect(settings.getByRole("button", { name: "7 days" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(() => requests.some((body) => body.includes('"botId":"bot-1"') && body.includes('"7d"')))
    .toBe(true);
  const totals = settings.getByTestId("usage-settings").locator("dl");
  await expect(totals).toContainText("330,000");
  await expect(totals).toContainText("$1.40");
  await expect(settings.getByRole("row").filter({ hasText: "example-large" })).toContainText(
    "300,000",
  );
  await expect(settings.getByRole("button", { name: "Nov 12: 330,000 tokens, $1.40" })).toHaveCount(
    1,
  );
  await captureScreenshot(page, testInfo, "usage-limits-settings-filtered");
  await settings.getByRole("cell", { name: /example-large/ }).scrollIntoViewIfNeeded();
  const bar = settings.getByRole("button", { name: "Nov 12: 330,000 tokens, $1.40" });
  await bar.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(bar).toBeFocused();
  const tooltip = page.locator('[data-slot="tooltip-content"]');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("Nov 12: 330,000 tokens, $1.40");
  await page.keyboard.press("Escape");
  await captureScreenshot(page, testInfo, "usage-limits-chart");

  await page.route("**/api/auth/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), billing: true } });
  });
  await page.route("**/rpc/me", (route) => enableBilling(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => enableBilling(route, "bootstrap"));
  await page.route("**/rpc/billing/status", (route) =>
    route.fulfill({ json: { json: creditStatus } }),
  );
  await page.reload();
  await openUserSettings(page, "usage");
  await expect(page.getByTestId("credit-balance")).toContainText("$12.50 left");
  await captureScreenshot(page, testInfo, "usage-limits-settings-credits");
});
