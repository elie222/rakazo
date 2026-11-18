import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { AppBootstrap, Me, RpcOutput } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

const meetingUrl = "https://meet.google.com/abc-defg-hij";
const launchDecision = "We agreed to send the launch draft on Friday.";
const question = "When is the launch draft due?";
const answer = "The launch draft is due Friday. Sam will check the final copy.";

test("a bot joins a meeting and brings its transcript back to chat", async ({ page }, testInfo) => {
  if (process.env.MEETING_PROVIDER !== "emulator") await emulateMeetingReadsAndWrites(page);
  await signup(page, `meeting-${Date.now()}@rakazo.test`, "password12", "Meeting Tester");
  await completeOnboarding(page);
  await page.getByRole("button", { name: "Meetings", exact: true }).click();

  const meetings = page.getByRole("dialog", { name: "Meetings" });
  await meetings.getByRole("textbox", { name: "Meeting link" }).fill(meetingUrl);
  await meetings.getByRole("button", { name: "Join meeting" }).click();
  await expect(meetings.getByText("In the meeting", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "meeting-joined");

  await meetings.getByRole("button", { name: "Leave meeting" }).click();
  await meetings.getByRole("button", { name: "View transcript" }).click();
  const transcript = page.getByRole("dialog", { name: "Transcript" });
  await expect(transcript.getByText("Alex Rivera", { exact: true })).toBeVisible();
  await expect(transcript.getByText(launchDecision, { exact: true })).toBeVisible();
  await expect(transcript.getByText("Sam Chen", { exact: true })).toBeVisible();
  await expect(transcript.getByText("I will check the final copy.", { exact: true })).toBeVisible();
  await transcript.getByRole("textbox", { name: "Ask about this meeting" }).fill(question);
  await transcript.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(transcript.getByText(answer, { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "meeting-transcript");

  await transcript.getByRole("button", { name: "Delete transcript" }).click();
  await page
    .getByRole("alertdialog", { name: "Delete this transcript?" })
    .getByRole("button", { name: "Delete transcript" })
    .click();
  await expect(meetings.getByRole("button", { name: "View transcript" })).toHaveCount(0);
});

/** Supply the meeting RPC boundary when the regular UI screenshot runner has no meeting provider. */
async function emulateMeetingReadsAndWrites(page: Page) {
  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const data: { json?: AppBootstrap } = await response.json();
    if (data.json) data.json.me.meetingsEnabled = true;
    await route.fulfill({ response, json: data });
  });
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const data: { json?: Me } = await response.json();
    if (data.json) data.json.meetingsEnabled = true;
    await route.fulfill({ response, json: data });
  });
  let meeting: RpcOutput<"meetings/list">["meetings"][number] | undefined;
  const reply = (route: Route, json?: unknown) => route.fulfill({ json: { json } });
  await page.route("**/rpc/meetings/list", (route) =>
    reply(route, { enabled: true, meetings: meeting ? [meeting] : [] }),
  );
  await page.route("**/rpc/meetings/join", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      json: { botId: activeBotId(page), url: meetingUrl },
    });
    meeting = {
      id: "meeting-1",
      platform: "google_meet",
      status: "joined",
      createdAt: Date.UTC(2026, 10, 18, 14),
      transcriptAvailable: false,
    };
    return reply(route);
  });
  await page.route("**/rpc/meetings/leave", (route) => {
    if (meeting) meeting = { ...meeting, status: "ready", transcriptAvailable: true };
    return reply(route);
  });
  await page.route("**/rpc/meetings/transcript", (route) =>
    reply(route, {
      turns: [
        { speaker: "Alex Rivera", startMs: 0, text: launchDecision },
        { speaker: "Sam Chen", startMs: 4100, text: "I will check the final copy." },
      ],
    }),
  );
  await page.route("**/rpc/meetings/ask", (route) => {
    expect(route.request().postDataJSON()).toEqual({ json: { id: "meeting-1", question } });
    return reply(route, { answer });
  });
  await page.route("**/rpc/meetings/deleteTranscript", (route) => {
    if (meeting) meeting = { ...meeting, status: "ended", transcriptAvailable: false };
    return reply(route);
  });
}
