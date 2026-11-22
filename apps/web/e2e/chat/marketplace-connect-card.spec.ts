import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  rpc,
  signup,
} from "../helpers/helpers";

test("a bot connects a marketplace connector from chat and carries on once it is signed in", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signup(page, `chat-marketplace-${Date.now()}@rakazo.test`, "password12", "Sample");
  await completeOnboarding(page);
  await rpc(page, "onboarding/dismissFocus", { botId: activeBotId(page) });
  let cancel = true;
  await page.context().route("https://marketplace-auth.example.test/authorize**", async (route) => {
    if (cancel)
      return route.fulfill({ contentType: "text/html", body: "<h1>Fixture provider sign-in</h1>" });
    const authorize = new URL(route.request().url());
    const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("state", authorize.searchParams.get("state")!);
    redirect.searchParams.set("code", "fake-marketplace-code");
    return route.fulfill({ status: 302, headers: { location: redirect.toString() } });
  });

  await page.getByPlaceholder(/Message/).fill("Can you connect to Planning Notes?");
  await page.keyboard.press("Enter");
  const card = page.getByTestId("mcp-approval-card");
  await expect(card.getByText("Planning Notes", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("Plan work and write notes", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "chat-marketplace-pending");

  // Closing the sign-in leaves the card ready to try again.
  const abandoned = page.waitForEvent("popup");
  await card.getByRole("button", { name: "Authorize", exact: true }).click();
  await (await abandoned).close();
  await expect(card.getByRole("button", { name: "Authorize", exact: true })).toBeEnabled();

  cancel = false;
  const popup = page.waitForEvent("popup");
  await card.getByRole("button", { name: "Authorize", exact: true }).click();
  await expect.poll(async () => (await popup).isClosed()).toBe(true);
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  // The bot carries on by itself; the scripted model echoes the turn it was given.
  await expect(
    page
      .getByTestId("message-bot-bubble")
      .getByText(/i handled: The user just connected the MCP server "Planning Notes"/),
  ).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, testInfo, "chat-marketplace-connected");
});
