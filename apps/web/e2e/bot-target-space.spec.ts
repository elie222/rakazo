import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

for (const decision of ["allow", "deny"] as const) {
  test(`cross-space bot creation: ${decision} in the named destination`, async ({
    page,
  }, testInfo) => {
    await signup(
      page,
      `spawn-space-${decision}-${Date.now()}@rakazo.test`,
      "password12",
      "Space Owner",
    );
    await completeOnboarding(page);
    const sourceBotId = activeBotId(page);
    const sourceSpaceId = await page.evaluate(() => localStorage.getItem("rakazo:space-id"));
    const target = await rpc<{ id: string; name: string }>(page, "spaces/create", {
      name: "Customer support",
    });
    const targetBots = async () => {
      const response = await page.request.post("/rpc/bots/list", {
        headers: { "x-rakazo-space-id": target.id },
        data: { json: {} },
      });
      expect(response.ok()).toBe(true);
      return ((await response.json()) as { json: Array<{ id: string; name: string }> }).json;
    };
    const composer = page.getByRole("combobox", { name: "Message Chief" });
    await composer.fill('Create a bot named Scout in space "Customer support"');
    await composer.press("Enter");
    const transcript = page.getByTestId("transcript");
    await expect(
      transcript.getByText("Create bot “Scout” in “Customer support”?", { exact: true }),
    ).toBeVisible();
    await expect(transcript.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
    await expect(transcript.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
    await expect(transcript.getByRole("button", { name: "Always allow this tool" })).toHaveCount(0);
    expect(await targetBots()).toEqual([]);
    await captureScreenshot(page, testInfo, `cross-space-${decision}-approval`);
    await transcript
      .getByRole("button", { name: decision === "allow" ? "Allow once" : "Deny", exact: true })
      .click();

    if (decision === "deny") {
      await expect(transcript.getByText("Denied", { exact: true })).toBeVisible();
      await expect
        .poll(async () => {
          const snapshot = await rpc<{ run: unknown }>(page, "threads/get", { botId: sourceBotId });
          return snapshot.run;
        })
        .toBeNull();
      expect(await targetBots()).toEqual([]);
      await expect(
        transcript.getByRole("button").filter({ hasText: "Scout specialist" }),
      ).toHaveCount(0);
      await captureScreenshot(page, testInfo, "cross-space-denied");
      return;
    }

    await expect.poll(async () => (await targetBots()).map((bot) => bot.name)).toEqual(["Scout"]);
    const [created] = await targetBots();
    expect(created).toBeTruthy();
    const localBots = await rpc<Array<{ id: string }>>(page, "bots/list", {});
    expect(localBots.some((bot) => bot.id === created!.id)).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem("rakazo:space-id"))).toBe(sourceSpaceId);
    const childCard = transcript.getByRole("button").filter({ hasText: "Scout specialist" });
    await expect(childCard).toBeVisible();
    await childCard.click();
    await expect(page).toHaveURL(new RegExp(`/app/${created!.id}$`));
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("rakazo:space-id")))
      .toBe(target.id);
    await expect(page.getByRole("combobox", { name: "Message Scout" })).toBeVisible();
    await captureScreenshot(page, testInfo, "cross-space-created-destination");
  });
}
