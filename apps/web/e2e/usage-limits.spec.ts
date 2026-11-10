import { expect, test } from "@playwright/test";
import type { PlanLimits } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

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

test("account menu and Usage show subscription allowances", async ({ page }, testInfo) => {
  await page.route("**/rpc/usage/limits", (route) => route.fulfill({ json: { json: plans } }));
  const stamp = Date.now();
  await signup(page, `usage-limits-${stamp}@rakazo.test`, "password12", "Usage limits");
  await completeOnboarding(page);

  await page.getByTestId("user-menu-trigger").click();
  const menu = page.locator('[data-slot="popover-content"]');
  const usage = menu.getByRole("button", { name: /^Usage/ });
  await expect(usage).toContainText("93% used");
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
  // Nobody here has bought credits, so there is no balance to show.
  await expect(settings.getByTestId("credit-balance")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "usage-limits-settings");
});
