import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

const meetingUrl = "https://meet.google.com/abc-defg-hij";
const launchDecision = "We agreed to send the launch draft on Friday.";
const question = "When is the launch draft due?";
const answer = "The launch draft is due Friday. Sam will check the final copy.";

async function expectSameHeight(input: Locator, button: Locator) {
  const height = await input.evaluate((element) => element.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(0);
  expect(await button.evaluate((element) => element.getBoundingClientRect().height)).toBe(height);
}

test("a bot joins a meeting and brings its transcript back to chat", async ({ page }, testInfo) => {
  test.skip(
    process.env.MEETING_PROVIDER?.trim() !== "emulator",
    "This flow requires MEETING_PROVIDER=emulator to exercise the offline meeting adapter.",
  );
  await signup(page, `meeting-${Date.now()}@rakazo.test`, "password12", "Meeting Tester");
  await completeOnboarding(page);
  await page.getByRole("button", { name: "Meetings", exact: true }).click();

  const meetings = page.getByRole("dialog", { name: "Meetings" });
  const linkInput = meetings.getByRole("textbox", { name: "Meeting link" });
  const joinButton = meetings.getByRole("button", { name: "Join meeting" });
  await linkInput.fill(meetingUrl);
  await expectSameHeight(linkInput, joinButton);
  await joinButton.click();
  await expect(meetings.getByText("In the meeting", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "meeting-joined");

  await meetings.getByRole("button", { name: "Leave meeting" }).click();
  await meetings.getByRole("button", { name: "View transcript" }).click();
  const transcript = page.getByRole("dialog", { name: "Transcript" });
  await expect(transcript.getByText("Alex Rivera", { exact: true })).toBeVisible();
  await expect(transcript.getByText(launchDecision, { exact: true })).toBeVisible();
  await expect(transcript.getByText("Sam Chen", { exact: true })).toBeVisible();
  await expect(transcript.getByText("I will check the final copy.", { exact: true })).toBeVisible();
  const questionInput = transcript.getByRole("textbox", { name: "Ask about this meeting" });
  const askButton = transcript.getByRole("button", { name: "Ask", exact: true });
  await questionInput.fill(question);
  await expectSameHeight(questionInput, askButton);
  await askButton.click();
  await expect(transcript.getByText(answer, { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "meeting-transcript");

  await transcript.getByRole("button", { name: "Delete transcript" }).click();
  await page
    .getByRole("alertdialog", { name: "Delete this transcript?" })
    .getByRole("button", { name: "Delete transcript" })
    .click();
  await expect(meetings.getByRole("button", { name: "View transcript" })).toHaveCount(0);
});
