import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

const meetingUrl = "https://teams.microsoft.com/meet/123456789012?p=fake-passcode";
const launchDecision = "We agreed to send the launch draft on Friday.";

async function expectSameHeight(input: Locator, button: Locator) {
  const height = await input.evaluate((element) => element.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(0);
  expect(await button.evaluate((element) => element.getBoundingClientRect().height)).toBe(height);
}

test("a bot joins a meeting and saves its transcript as an artifact", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.MEETING_PROVIDER?.trim() !== "emulator",
    "This flow requires MEETING_PROVIDER=emulator to exercise the offline meeting adapter.",
  );
  await signup(page, `meeting-${Date.now()}@rakazo.test`, "password12", "Meeting Tester");
  await completeOnboarding(page);
  const chat = page.url();
  await page.getByRole("button", { name: "Meetings", exact: true }).click();

  const meetings = page.getByRole("dialog", { name: "Meetings" });
  const linkInput = meetings.getByRole("textbox", { name: "Meeting link" });
  const joinButton = meetings.getByRole("button", { name: "Join meeting" });
  await linkInput.fill("invalid meeting link");
  await joinButton.click();
  await expect(
    meetings.getByText("Enter a valid Zoom, Google Meet, or Microsoft Teams link.", {
      exact: true,
    }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "meeting-invalid-link");
  await linkInput.fill(meetingUrl);
  await expectSameHeight(linkInput, joinButton);
  await joinButton.click();
  await expect(meetings.getByText("In the meeting", { exact: true })).toBeVisible();
  await expect(meetings.getByText("Microsoft Teams", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "meeting-joined");

  await meetings.getByRole("button", { name: "Leave meeting" }).click();
  await meetings.getByRole("button", { name: "View transcript" }).click();
  const transcript = page.getByRole("dialog", { name: "Transcript" });
  await expect(transcript.getByText("Alex Rivera", { exact: true })).toBeVisible();
  await expect(transcript.getByText(launchDecision, { exact: true })).toBeVisible();
  await expect(transcript.getByText("Sam Chen", { exact: true })).toBeVisible();
  await expect(transcript.getByText("I will check the final copy.", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "meeting-transcript");

  await page.keyboard.press("Escape");
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Artifacts", exact: true }).click();
  await page.getByText(/^Meeting transcript .* UTC\.txt$/).click();
  await expect(page.getByText(launchDecision, { exact: false })).toBeVisible();
  await captureScreenshot(page, testInfo, "meeting-transcript-artifact");

  await page.goto(chat);
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await meetings.getByRole("button", { name: "View transcript" }).click();

  await transcript.getByRole("button", { name: "Delete transcript" }).click();
  await page
    .getByRole("alertdialog", { name: "Delete this transcript?" })
    .getByRole("button", { name: "Delete transcript" })
    .click();
  await expect(meetings.getByRole("button", { name: "View transcript" })).toHaveCount(0);
});
