import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("Enter picks the highlighted slash skill instead of sending", async ({ page }, testInfo) => {
  await signup(page, `slash-enter-${Date.now()}@rakazo.test`, "password12", "Slash Owner");
  await completeOnboarding(page);
  await rpc(page, "agentSkills/create", {
    content: [
      "---",
      "name: weekly-review",
      "description: Summarize the week's progress and blockers.",
      "---",
      "",
      "List what shipped, what slipped, and what is blocked.",
    ].join("\n"),
  });
  await page.reload();
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill("/week");
  const skill = page
    .getByTestId("slash-picker")
    .getByRole("option", { name: "Skill weekly-review", exact: true });
  await expect(skill).toHaveAttribute("aria-selected", "true");
  await captureScreenshot(page, testInfo, "composer-slash-highlight");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Remove skill weekly-review" })).toBeVisible();
  await expect(composer).toHaveValue("");
  await expect(page.getByText("/week", { exact: true })).toHaveCount(0);
});

test("a slash skill picked mid-message keeps the words around it", async ({ page }, testInfo) => {
  await signup(page, `slash-inline-${Date.now()}@rakazo.test`, "password12", "Slash Owner");
  await completeOnboarding(page);
  await rpc(page, "agentSkills/create", {
    content: [
      "---",
      "name: weekly-review",
      "description: Summarize the week's progress and blockers.",
      "---",
      "",
      "List what shipped, what slipped, and what is blocked.",
    ].join("\n"),
  });
  await page.reload();
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill("please run /week");
  await expect(
    page
      .getByTestId("slash-picker")
      .getByRole("option", { name: "Skill weekly-review", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await composer.press("Enter");
  await expect(composer).toHaveValue("please run ");
  await expect(page.getByRole("button", { name: "Remove skill weekly-review" })).toBeVisible();
  await captureScreenshot(page, testInfo, "composer-slash-inline");
});
