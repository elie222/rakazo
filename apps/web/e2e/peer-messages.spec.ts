import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("shows centred exchange lines and opens the bot-to-bot chat", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `peer-msg-${stamp}@rakazo.test`, "password12", "Peer Msg");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const chiefId = activeBotId(page);
  await rpc(page, "bots/create", {
    name: "Researcher",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible();

  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill("message the bot named Researcher saying peer-exchange-alpha");
  await composer.press("Enter");

  await expect
    .poll(
      async () => {
        const history = await rpc<{
          messages: Array<{ blocks: Array<{ kind: string; text?: string }> }>;
        }>(page, "threads/messages", { botId: chiefId, includePeerRuns: true });
        const peerTexts = history.messages.flatMap((message) =>
          message.blocks
            .filter(
              (block) => block.kind === "bot_message_sent" || block.kind === "bot_message_received",
            )
            .map((block) => block.text ?? ""),
        );
        return peerTexts.some((text) => text.includes("peer-exchange-alpha"));
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });

  const transcript = page.getByTestId("transcript");
  const chip = transcript
    .getByTestId("peer-receipt-chip")
    .filter({ hasText: "Researcher" })
    .first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip.getByText(/Messaged|Message from|messages with/)).toBeVisible();
  await expect(chip).toHaveAccessibleName(
    /Messaged Researcher|Message from Researcher|\d+ messages with Researcher/,
  );
  await expect(chip.locator(".rakazo-organic-avatar")).toBeVisible();
  await expect(chip).not.toContainText("{peer}");
  // User bubble still contains the phrase; peer body must not appear outside the chip.
  await expect(chip).not.toContainText("peer-exchange-alpha");
  await expect(transcript.getByText("peer-exchange-alpha")).toHaveCount(1);
  const assertChipCentred = async () => {
    const transcriptBox = await transcript.boundingBox();
    const chipBox = await chip.boundingBox();
    expect(transcriptBox).not.toBeNull();
    expect(chipBox).not.toBeNull();
    expect(
      Math.abs(chipBox!.x + chipBox!.width / 2 - transcriptBox!.x - transcriptBox!.width / 2),
    ).toBeLessThan(3);
    // Stay under 75% of the transcript width so the chip cannot become a full-width bar.
    expect(chipBox!.width).toBeLessThan(transcriptBox!.width * 0.75);
  };

  await assertChipCentred();
  await expect(composer).toBeVisible();
  await captureScreenshot(page, testInfo, "peer-chip-desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await chip.scrollIntoViewIfNeeded();
  await expect(chip).toBeVisible();
  await expect(composer).toBeVisible();
  await assertChipCentred();
  await captureScreenshot(page, testInfo, "peer-chip-mobile");

  await chip.focus();
  await expect(chip).toBeFocused();
  await chip.press("Enter");
  const view = page.getByTestId("peer-conversation-view");
  await expect(view).toBeVisible();
  await expect(view.getByRole("heading", { name: /Chief.*Researcher/ })).toBeVisible();
  await expect(view.getByRole("button", { name: "Close Chat" })).toHaveCount(1);
  await expect(view.getByText("peer-exchange-alpha").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(view.getByRole("textbox")).toHaveCount(0);
  await expect(view.getByText("Loading")).toHaveCount(0);
  const peerTranscript = view.getByTestId("peer-conversation-transcript");
  await peerTranscript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() =>
      peerTranscript.evaluate(
        (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
      ),
    )
    .toBe(true);
  await captureScreenshot(page, testInfo, "peer-view-only");
  await view.getByRole("button", { name: "Close Chat" }).click();
  await expect(view).toHaveCount(0);
});

for (const intent of ["request", "result", "fyi"] as const) {
  test(`${intent} wake keeps the reply in its intended conversation`, async ({
    page,
  }, testInfo) => {
    await signup(page, `peer-${intent}-${Date.now()}@rakazo.test`, "password12", "Peer Chat");
    await completeOnboarding(page);
    await page.goto("/app");
    await page.waitForURL(/\/app\/[^/]+$/);
    const botId = activeBotId(page);
    const peer = await rpc<{ id: string }>(page, "bots/create", {
      name: "Writer",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    let threadId = "";
    const createdAt = new Date().toISOString();
    const bodyText = "Here is the report for you.";
    const receipt = {
      id: "peer-wake-fixture",
      role: "bot",
      runId: "peer-run-fixture",
      botId,
      seq: 10001,
      createdAt,
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: peer.id,
          fromBotName: "Writer",
          intent,
          text: "Draft the launch note.",
        },
      ],
    };
    const reply = {
      ...receipt,
      id: "peer-reply-fixture",
      seq: 10002,
      blocks: [{ kind: "text", text: bodyText }],
    };
    const echo = {
      ...receipt,
      id: "peer-echo-fixture",
      seq: 10003,
      blocks: [
        {
          kind: "bot_message_sent",
          toBotId: peer.id,
          toBotName: "Writer",
          text: bodyText,
          intent: "result",
        },
      ],
    };
    const fixtureMessages = intent === "request" ? [receipt, reply, echo] : [receipt, reply];
    await page.route("**/rpc/threads/get", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      threadId = body.json.threadId;
      body.json.messages = [
        ...body.json.messages,
        ...fixtureMessages.map((message) => ({ ...message, threadId })),
      ];
      body.json.cursor = 10003;
      await route.fulfill({ response, json: body });
    });
    await page.route("**/rpc/threads/messages", async (route) => {
      await route.fulfill({
        json: {
          json: {
            threadId,
            messages: fixtureMessages.map((message) => ({ ...message, threadId })),
            olderCursor: null,
          },
        },
      });
    });
    await page.reload();
    const transcript = page.getByTestId("transcript");
    const line = transcript.getByTestId("peer-receipt-chip").filter({ hasText: "Writer" });
    await expect(line).toBeVisible();
    if (intent === "request") {
      await expect(line).toHaveAccessibleName("2 messages with Writer");
      await expect(transcript.getByText(bodyText, { exact: true })).toHaveCount(0);
    } else {
      await expect(line).toHaveAccessibleName("Message from Writer");
      await expect(transcript.getByText(bodyText, { exact: true })).toBeVisible();
    }
    await line.click();
    const view = page.getByTestId("peer-conversation-view");
    await expect(view.getByText("Draft the launch note.")).toBeVisible();
    await expect(view.getByRole("heading")).toContainText("Chief");
    await expect(view.getByRole("heading")).toContainText("Writer");
    if (intent === "request") await expect(view.getByText(bodyText, { exact: true })).toBeVisible();
    else await expect(view.getByText(bodyText, { exact: true })).toHaveCount(0);
    await captureScreenshot(page, testInfo, `peer-${intent}-chat`);
    await view.getByRole("button", { name: "Close Chat" }).click();
    await expect(view).toHaveCount(0);
    if (intent === "request") {
      const jumped = page.waitForResponse(
        (response) =>
          response.url().includes("/rpc/threads/messages") &&
          (response.request().postData() ?? "").includes('"around"'),
      );
      await page.evaluate(() => {
        history.pushState({}, "", "?m=peer-reply-fixture");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await jumped;
      await expect(page).not.toHaveURL(/[?&]m=/);
      await expect(line).toBeInViewport();
      await expect(transcript.getByText(bodyText, { exact: true })).toHaveCount(0);
      await captureScreenshot(page, testInfo, "peer-folded-reply-jump");
    }
  });
}
