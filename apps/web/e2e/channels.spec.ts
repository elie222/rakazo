import { expect, test } from "@playwright/test";
import type { Bot } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("named channels persist membership, mentions, replies, and renames", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `channels-${stamp}@rakazo.test`, "password12", "Channel Owner");
  await completeOnboarding(page, ["A bit of everything", "Clear and tight"]);
  await rpc<Bot>(page, "bots/create", {
    name: "Analyst",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  });
  await page.reload();

  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "New Channel" }).click();
  const dialog = page.getByRole("dialog", { name: "New channel" });
  await dialog.getByLabel("Name").fill("design-room");
  await dialog.getByRole("checkbox", { name: "Chief" }).check();
  await dialog.getByRole("checkbox", { name: "Analyst" }).check();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  await page.waitForURL(/\/channel\/[^/]+$/);
  await expect(page.getByTestId("channel-view")).toBeVisible();
  const channelId = await page.getByTestId("channel-view").getAttribute("data-channel-id");
  if (!channelId) throw new Error("channel route did not expose an id");
  await expect(page.getByText("Chief", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Analyst", { exact: true }).first()).toBeVisible();

  const composer = page.getByPlaceholder(/Message #design-room/);
  await composer.fill("A note without a mention");
  await expect(
    page.getByText("No bot mentioned — nobody will reply to this message."),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "32-channel-empty-state");

  await composer.fill("@Chief please summarize the plan");
  await composer.press("Enter");
  await expect(page.getByText("@Chief please summarize the plan", { exact: true })).toBeVisible();
  await expect
    .poll(
      async () => {
        const detail = await rpc<{ messages: Array<{ authorType: string }> }>(
          page,
          "channels/get",
          { channelId },
        );
        return detail.messages.filter((message) => message.authorType === "bot").length;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByTestId("channel-transcript").locator("text=Chief").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "33-channel-reply");

  await page.getByRole("button", { name: "design-room", exact: true }).click();
  const nameInput = page.getByLabel("Channel name");
  await nameInput.fill("launch-room");
  await nameInput.press("Enter");
  await expect(page.getByRole("button", { name: "launch-room", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByPlaceholder(/Message #launch-room/)).toBeVisible();
});
