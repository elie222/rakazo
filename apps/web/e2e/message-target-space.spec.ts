import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { activeBotId, completeOnboarding, rpc, signup } from "./helpers";

type StoredMessage = {
  blocks: Array<{
    kind: string;
    text?: string;
    fromSpaceName?: string;
    toSpaceName?: string;
  }>;
};

async function scopedRpc<T>(
  page: Page,
  spaceId: string,
  procedure: string,
  body: unknown,
): Promise<T> {
  const response = await page.request.post(`/rpc/${procedure}`, {
    headers: { "x-rakazo-space-id": spaceId },
    data: { json: body },
  });
  const parsed = (await response.json()) as { json?: T; error?: { message?: string } };
  expect(response.ok(), `${procedure}: ${parsed.error?.message ?? response.status()}`).toBe(true);
  expect(parsed.error).toBeUndefined();
  return parsed.json as T;
}

test("explicit same-Space message approval resumes once with case-insensitive lookup", async ({
  page,
}, testInfo) => {
  await signup(
    page,
    `message-local-approval-${Date.now()}@rakazo.test`,
    "password12",
    "Space Owner",
  );
  await completeOnboarding(page);
  const scout = await rpc<{ id: string }>(page, "bots/create", {
    name: "Scout",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  });
  await rpc(page, "approvalRules/set", {
    effect: "require_approval",
    matchKind: "tool",
    matchValue: "message_bot",
  });
  const payload = `local-approved-${Date.now()}`;
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill(`message bot named scout in space Personal saying ${payload}`);
  await composer.press("Enter");
  const allow = page
    .getByTestId("transcript")
    .getByRole("button", { name: "Allow once", exact: true });
  await expect(allow).toBeVisible();
  const received = async () => {
    const history = await rpc<{ messages: StoredMessage[] }>(page, "threads/messages", {
      botId: scout.id,
      includePeerRuns: true,
    });
    return history.messages
      .flatMap((message) => message.blocks)
      .filter((block) => block.kind === "bot_message_received" && block.text === payload);
  };
  expect(await received()).toHaveLength(0);
  await allow.click();
  await expect.poll(received).toHaveLength(1);
  await expect(
    page.getByTestId("transcript").getByText("Allowed once", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("local-message-approved.png") });
});

for (const decision of ["allow", "deny"] as const) {
  test(`cross-Space message approval: ${decision}`, async ({ page }, testInfo) => {
    await signup(
      page,
      `message-space-${decision}-${Date.now()}@rakazo.test`,
      "password12",
      "Space Owner",
    );
    await completeOnboarding(page);
    const sourceBotId = activeBotId(page);
    const sourceSpaceId = (await rpc<{ spaceId: string }>(page, "me", {})).spaceId;
    expect(sourceSpaceId).toBeTruthy();

    const target = await rpc<{ id: string; name: string }>(page, "spaces/create", {
      name: "Research",
    });
    const scout = await scopedRpc<{ id: string; name: string }>(page, target.id, "bots/create", {
      name: "Scout",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const readMessages = (botId: string, spaceId: string) =>
      scopedRpc<{ messages: StoredMessage[] }>(page, spaceId, "threads/messages", {
        botId,
        includePeerRuns: true,
      }).then((history) => history.messages);
    const payload = `cross-space-${decision}-${Date.now()}`;
    const composer = page.getByRole("combobox", { name: "Message Chief" });
    await composer.fill(`message bot named Scout in space Research saying ${payload}`);
    await composer.press("Enter");

    const transcript = page.getByTestId("transcript");
    await expect(
      transcript.getByText("Review before message_bot from Personal to Research (Scout)", {
        exact: true,
      }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(transcript.getByText(`message: ${payload}`, { exact: false })).toBeVisible();
    await expect(transcript.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(
      1,
    );
    await expect(transcript.getByRole("button", { name: "Deny", exact: true })).toHaveCount(1);
    await expect(transcript.getByRole("button", { name: "Always allow this tool" })).toHaveCount(0);
    expect(await readMessages(scout.id, target.id)).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`cross-space-message-${decision}-approval.png`),
    });

    await transcript
      .getByRole("button", { name: decision === "allow" ? "Allow once" : "Deny", exact: true })
      .click();

    if (decision === "deny") {
      await expect(transcript.getByText("Denied", { exact: true })).toBeVisible();
      await expect.poll(() => readMessages(scout.id, target.id)).toEqual([]);
      const sourceMessages = await readMessages(sourceBotId, sourceSpaceId!);
      expect(
        sourceMessages
          .flatMap((message) => message.blocks)
          .some((block) => block.kind === "bot_message_sent" && block.text === payload),
      ).toBe(false);
      return;
    }

    await expect
      .poll(
        async () => {
          const targetMessages = await readMessages(scout.id, target.id);
          return targetMessages.some((message) =>
            message.blocks.some(
              (block) => block.kind === "bot_message_received" && block.text === payload,
            ),
          );
        },
        { timeout: 60_000 },
      )
      .toBe(true);

    await expect
      .poll(
        async () => {
          const sourceMessages = await readMessages(sourceBotId, sourceSpaceId!);
          return sourceMessages.some((message) =>
            message.blocks.some(
              (block) =>
                block.kind === "bot_message_received" && block.fromSpaceName === "Research",
            ),
          );
        },
        { timeout: 60_000 },
      )
      .toBe(true);

    const sentChip = transcript
      .getByTestId("peer-receipt-chip")
      .filter({ hasText: "Messaged Scout in Research" })
      .first();
    await expect(sentChip).toBeVisible({ timeout: 30_000 });
    await expect(sentChip).toHaveAccessibleName("Messaged Scout in Research");
    await sentChip.click();

    const peerView = page.getByTestId("peer-conversation-view");
    await expect(peerView).toBeVisible();
    await expect(peerView.getByRole("button", { name: "Open chat", exact: true })).toHaveCount(1);
    await expect(peerView.getByRole("textbox")).toHaveCount(0);
    await peerView.getByRole("button", { name: "Open chat", exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/app/${scout.id}$`));
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("rakazo:space-id")))
      .toBe(target.id);
    await expect(page.getByRole("combobox", { name: "Message Scout" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("cross-space-message-destination.png") });
  });
}
