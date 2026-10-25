import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("a message to a bot that shares a group is posted in that group", async ({
  page,
}, testInfo) => {
  await signup(page, `group-peer-${Date.now()}@rakazo.test`, "password12", "Group Peer");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const chiefId = activeBotId(page);
  const researcher = await rpc<{ id: string }>(page, "bots/create", {
    name: "Researcher",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Launch desk",
    botIds: [chiefId, researcher.id],
  });
  await page.reload();

  const chiefComposer = page.getByRole("combobox", { name: "Message Chief" });
  await chiefComposer.fill("message the bot named Researcher saying group-peer-alpha");
  await chiefComposer.press("Enter");

  // Chief relays Researcher's result in its own chat, under its "Messaged Researcher" receipt.
  const chiefTranscript = page.getByTestId("transcript");
  await expect(
    chiefTranscript.getByText("Here's what Researcher found: done. i handled: group-peer-alpha"),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    chiefTranscript.getByTestId("peer-receipt-chip").filter({ hasText: "Messaged Researcher" }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "group-bot-message-chief");

  // The exchange itself is visible in the group: Chief's handoff line and Researcher's answer.
  await page.goto(`/app/g/${group.id}`);
  await expect(page.getByRole("combobox", { name: "Message Launch desk" })).toBeVisible();
  const groupTranscript = page.getByTestId("transcript");
  await expect(groupTranscript.getByText("↪ Researcher ← Chief")).toBeVisible({
    timeout: 30_000,
  });
  await expect(groupTranscript.getByText("group-peer-alpha", { exact: true })).toBeVisible();
  await expect(groupTranscript.getByText(/done\. i handled: group-peer-alpha/)).toBeVisible();
  await captureScreenshot(page, testInfo, "group-bot-message-handoff");
});
