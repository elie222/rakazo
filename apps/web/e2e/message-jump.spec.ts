import { expect, test } from "@playwright/test";
import { activeBotId, completeOnboarding, rpc, signup } from "./helpers";

test("a ?m= deep link jumps while the thread is streaming", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `jump-${stamp}@rakazo.test`, "password12", "Jump Tester");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const transcript = page.getByTestId("transcript");
  const composer = page.getByRole("combobox", { name: /Message/ });
  const rows = transcript.locator("[data-message-id]");

  const targetText = `jump-target-${stamp}`;
  await composer.fill(targetText);
  await composer.press("Enter");
  const targetRow = rows
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: targetText })
    .first();
  await expect(targetRow).toBeVisible({ timeout: 20_000 });
  const messageId = await targetRow.getAttribute("data-message-id");
  if (!messageId) throw new Error("missing data-message-id");

  // Flood the thread: every successful send steers the run, so SSE events keep
  // committing urgent updates — the churn that previously starved the router's
  // navigation transition. Only completed sends count; a flood that cannot
  // land makes the streaming precondition below fail instead of passing
  // vacuously.
  let flooding = true;
  let sent = 0;
  const flood = Promise.all(
    Array.from({ length: 3 }, async (_, lane) => {
      let i = 0;
      while (flooding) {
        const nonce = `jf-${stamp}-${lane}-${i++}`;
        try {
          await rpc(page, "threads/send", {
            botId,
            text: `jump-flood-${stamp}-${lane}-${i}`,
            clientNonce: nonce,
          });
          sent++;
        } catch {
          // A rejected send contributes no churn; keep flooding and let the
          // precondition decide whether enough landed.
        }
      }
    }),
  );
  try {
    // Precondition: the stream is really committing — rows keep appearing.
    const rowsBefore = await rows.count();
    await expect.poll(() => rows.count(), { timeout: 20_000 }).toBeGreaterThan(rowsBefore);

    // The flood has pushed the target out of the live window.
    await expect(targetRow).not.toBeInViewport({ timeout: 20_000 });
    const sentAtPush = sent;

    const aroundJump = page.waitForResponse(
      (response) =>
        response.url().includes("/rpc/threads/messages") &&
        (response.request().postData() ?? "").includes('"around"'),
      { timeout: 15_000 },
    );
    await page.evaluate((id) => {
      history.pushState({}, "", `?m=${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, messageId);
    // The jump's finally strips this one-shot param as soon as the around-fetch
    // settles. toHaveURL only samples the current URL, so under load the first
    // poll can already miss ?m= and then retry a value that will not return.
    // The around response is the proof the router observed the deep link.

    // The jump lands mid-stream: the around-page fetch succeeds while sends
    // keep landing, and the target scrolls back into view. (The transcript
    // unfollows the tail for a jump; before that, follow commits could cancel
    // the scroll — asserting the viewport also guards that path.)
    const aroundResponse = await aroundJump;
    expect(aroundResponse.ok()).toBe(true);
    await expect.poll(() => sent, { timeout: 10_000 }).toBeGreaterThan(sentAtPush);
    await expect(targetRow).toBeInViewport({ timeout: 20_000 });

    // The one-shot param is stripped so a refresh does not re-jump.
    await expect(page).not.toHaveURL(/[?&]m=/, { timeout: 20_000 });
  } finally {
    flooding = false;
    await flood;
    await rpc(page, "threads/stop", { botId }).catch(() => {});
  }
});
