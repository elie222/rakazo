import { expect, type Page, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

function slackCard(page: Page) {
  return page.getByRole("group", { name: "Slack connection" });
}

test("focus choice suggests apps and preserves a completed connection", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `onboarding-${stamp}@rakazo.test`, "password12", "Robin");
  await completeOnboarding(page);

  await expect(
    page.getByText("Hey Robin. Fresh start on my side, so I’ll keep this short."),
  ).toBeVisible();
  await expect(page.getByText("What do you want me on first?", { exact: true })).toBeVisible();
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "01-focus-choice");

  await page.getByRole("button", { name: /Day-to-day work/ }).click();
  // The focus step suggests apps but must not rename the bot: the name the
  // user chose during creation ("Chief") is preserved.
  await expect(page.locator("main").getByText("Chief", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await expect(page.getByText("Slack", { exact: true })).toBeVisible();
  await expect(page.getByText("Gmail", { exact: true })).toBeVisible();
  const connectionCards = page.getByRole("group", { name: / connection$/ });
  await expect(connectionCards).toHaveCount(3);
  const cardBoxes = await connectionCards.evaluateAll((cards) =>
    cards.map((card) => {
      const { bottom, top } = card.getBoundingClientRect();
      return { bottom, top };
    }),
  );
  expect(cardBoxes[1].top - cardBoxes[0].bottom).toBeGreaterThanOrEqual(8);
  expect(cardBoxes[2].top - cardBoxes[1].bottom).toBeGreaterThanOrEqual(8);
  await page
    .getByTestId("transcript")
    .getByText("Hit those three and I’ll start pulling the picture.")
    .scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "02-app-suggestions");
  const authorizeButton = slackCard(page).getByRole("button", { name: "Authorize" });
  const restingBackground = await authorizeButton.evaluate(
    (button) => getComputedStyle(button).backgroundColor,
  );
  const accentBackground = await authorizeButton.evaluate((button) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--accent)";
    button.append(probe);
    const backgroundColor = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return backgroundColor;
  });
  expect(accentBackground).not.toBe(restingBackground);
  await authorizeButton.hover();
  await expect
    .poll(() => authorizeButton.evaluate((button) => getComputedStyle(button).backgroundColor))
    .toBe(accentBackground);
  await captureScreenshot(page, testInfo, "02-app-suggestions-authorize-hover");

  await authorizeButton.click();
  await expect(slackCard(page).getByText("Connected", { exact: true })).toBeVisible();
  await expect(slackCard(page).getByText("Connected", { exact: true })).toHaveCSS("opacity", "1");
  await expect
    .poll(async () => {
      const connections = await rpc<Array<{ provider: string; status: string }>>(
        page,
        "connections/list",
        {},
      );
      return connections.some(
        (connection) => connection.provider === "SLACK" && connection.status === "connected",
      );
    })
    .toBe(true);
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "03-slack-connected");

  await page.reload();
  await expect(slackCard(page).getByText("Connected", { exact: true })).toBeVisible();
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "04-connected-after-reload");
});
