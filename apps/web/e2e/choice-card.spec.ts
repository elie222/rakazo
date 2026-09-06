import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("renders tappable choice buttons and submits the offered action id", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `choice-card-${stamp}@rakazo.test`, "password12", "Choice Card");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("pick from these cities with tappable choices");
  await page.keyboard.press("Enter");

  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe("waiting_input");

  // threads/get can observe waiting_input before the shell realtime feed paints the ask card.
  const prompt = page.locator("p").filter({ hasText: /^Which city should I use\?$/ });
  if ((await prompt.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(prompt).toBeVisible({ timeout: 15_000 });

  const berlin = page.getByRole("button", { name: "Berlin", exact: true });
  const seoul = page.getByRole("button", { name: "Seoul", exact: true });
  const toronto = page.getByRole("button", { name: "Toronto", exact: true });
  const lisbon = page.getByRole("button", { name: "Lisbon", exact: true });
  await expect(berlin).toBeVisible();
  await expect(seoul).toBeVisible();
  await expect(toronto).toBeVisible();
  await expect(lisbon).toBeVisible();

  // Options render as a vertical full-width list, not wrapping chips.
  const berlinBox = await berlin.boundingBox();
  const seoulBox = await seoul.boundingBox();
  const torontoBox = await toronto.boundingBox();
  expect(berlinBox).toBeTruthy();
  expect(seoulBox).toBeTruthy();
  expect(torontoBox).toBeTruthy();
  expect(seoulBox!.y).toBeGreaterThan(berlinBox!.y + berlinBox!.height - 2);
  expect(torontoBox!.y).toBeGreaterThan(seoulBox!.y + seoulBox!.height - 2);
  expect(Math.abs(berlinBox!.x - seoulBox!.x)).toBeLessThan(2);
  expect(Math.abs(berlinBox!.width - seoulBox!.width)).toBeLessThan(2);
  const optionList = berlin.locator("xpath=ancestor::div[contains(@class,'space-y-1.5')][1]");
  const listBox = await optionList.boundingBox();
  expect(listBox).toBeTruthy();
  expect(Math.abs(berlinBox!.width - listBox!.width)).toBeLessThan(2);
  await captureScreenshot(page, testInfo, "choice-card");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(berlin).toBeVisible();
  await expect(lisbon).toBeVisible();
  const narrowBerlin = await berlin.boundingBox();
  const narrowLisbon = await lisbon.boundingBox();
  expect(narrowBerlin).toBeTruthy();
  expect(narrowLisbon).toBeTruthy();
  expect(narrowLisbon!.y).toBeGreaterThan(narrowBerlin!.y);
  await expect(lisbon).toBeEnabled();
  await captureScreenshot(page, testInfo, "choice-card-narrow");

  await page.setViewportSize({ width: 1280, height: 720 });
  await seoul.click();

  await expect(page.getByText("Answered: Seoul", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Seoul", exact: true })).toHaveCount(0);

  await expect
    .poll(
      async () => {
        const history = await rpc<{
          messages: Array<{
            blocks: Array<{
              kind: string;
              status?: string;
              answer?: string;
              actions?: Array<{ id: string; label: string }>;
            }>;
          }>;
        }>(page, "threads/messages", { botId });
        const answered = history.messages
          .flatMap((message) => message.blocks)
          .find(
            (block) =>
              block.kind === "ask" &&
              block.status === "answered" &&
              Array.isArray(block.actions) &&
              block.actions.some((action) => action.id === "choice-2"),
          );
        return answered?.answer ?? null;
      },
      { timeout: 30_000 },
    )
    .toBe("choice-2");

  await captureScreenshot(page, testInfo, "choice-card-answered");
});
