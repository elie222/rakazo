import { expect, test } from "@playwright/test";
import type { ThreadSnapshot } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("unread boundary stays in place and reading advances only through visible messages", async ({
  page,
}, testInfo) => {
  await signup(page, `unread-${Date.now()}@rakazo.test`, "password12", "Unread Tester");
  await completeOnboarding(page);
  const homeBotId = activeBotId(page);
  const bot = await rpc<{ id: string }>(page, "bots/create", {
    name: "Notes",
    title: "",
    description: "",
    computerMode: "team",
  });
  const readSnapshot = () => rpc<ThreadSnapshot>(page, "threads/get", { botId: bot.id });
  const send = async (text: string) => {
    await rpc(page, "threads/send", { botId: bot.id, text });
    await expect
      .poll(async () => {
        const snapshot = await readSnapshot();
        return snapshot.run === null && snapshot.messages.at(-1)?.role === "bot";
      })
      .toBe(true);
  };

  await send("Remember the first note.");
  await rpc(page, "threads/markRead", { botId: bot.id });
  const initial = await readSnapshot();
  const boundary = initial.readState!.lastReadSeq;
  await send("Here is the second note.");
  await send(
    Array.from({ length: 45 }, (_, index) => `Detail ${index + 1}: keep this note for later.`).join(
      "\n",
    ),
  );
  const unread = await readSnapshot();
  const firstUnread = unread.messages.find((message) => message.seq > boundary)!;
  const last = unread.messages.at(-1)!;
  expect(unread.readState?.unread).toBe(true);

  await page.goto(`/app/${bot.id}`);
  await page.bringToFront();
  const divider = page.getByTestId("unread-divider");
  await expect(divider).toHaveText("New messages");
  await expect(divider).toBeInViewport();
  const firstUnreadRow = page.locator(`[data-message-id="${firstUnread.id}"]`);
  await expect(firstUnreadRow).toBeInViewport();
  await expect
    .poll(async () => (await readSnapshot()).readState?.lastReadSeq)
    .toBeGreaterThan(boundary);
  const partial = await readSnapshot();
  expect(partial.readState?.lastReadSeq).toBeLessThan(last.seq);
  expect(partial.readState?.unread).toBe(true);
  await expect(page.locator(`[data-roster-bot-id="${bot.id}"]`)).toHaveAttribute(
    "data-roster-unread",
    "true",
  );
  await captureScreenshot(page, testInfo, "chat-unread-divider");

  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect.poll(async () => (await readSnapshot()).readState?.lastReadSeq).toBe(last.seq);
  await expect.poll(async () => (await readSnapshot()).readState?.unread).toBe(false);
  await expect(divider).toHaveCount(1);
  await page.goto(`/app/${homeBotId}`);
  await page.goto(`/app/${bot.id}`);
  await expect(page.getByTestId("transcript")).toContainText("Detail 45");
  await expect(divider).toHaveCount(0);
});

test("opens older unread history without exposing a gap or acknowledging the latest page", async ({
  page,
}, testInfo) => {
  await signup(page, `unread-history-${Date.now()}@rakazo.test`, "password12", "History Tester");
  await completeOnboarding(page);
  const bot = await rpc<{ id: string }>(page, "bots/create", {
    name: "History",
    title: "",
    description: "",
    computerMode: "team",
  });
  const snapshot = await rpc<ThreadSnapshot>(page, "threads/get", { botId: bot.id });
  const messages: ThreadSnapshot["messages"] = Array.from({ length: 140 }, (_, seq) => ({
    id: `unread-history-${seq}`,
    threadId: snapshot.threadId,
    botId: bot.id,
    seq,
    role: "bot",
    blocks: [{ kind: "text", text: `History note ${seq}` }],
    createdAt: new Date(Date.UTC(2026, 0, 1, 12, seq)).toISOString(),
  }));
  const readState = { lastReadSeq: 9, lastUnreadSeq: 139, unread: true };
  const hydrated: ThreadSnapshot = {
    ...snapshot,
    messages: messages.slice(120),
    olderCursor: 120,
    readState,
  };
  const reads: number[] = [];
  const pages: number[] = [];
  await page.route(/\/rpc\/(bootstrap|threads\/get)(?:\?|$)/, async (route) => {
    if (route.request().url().includes("/threads/get")) {
      await route.fulfill({ json: { json: hydrated } });
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    body.json.thread = hydrated;
    await route.fulfill({ response, json: body });
  });
  await page.route(/\/rpc\/threads\/messages(?:\?|$)/, async (route) => {
    const { json: input } = route.request().postDataJSON() as {
      json: { around?: { seq?: number } };
    };
    const seq = input.around?.seq;
    if (seq == null) throw new Error("Expected an around page for the unread boundary");
    pages.push(seq);
    const start = Math.max(0, seq - 25);
    const end = Math.min(140, seq + 25);
    // The first range contains only filtered background output. Its coverage
    // still separates the unread window from the cached latest page.
    const visiblePage = messages.slice(start, end).filter((message) => message.seq >= 35);
    await route.fulfill({
      json: {
        json: {
          threadId: snapshot.threadId,
          messages: visiblePage,
          olderCursor: start > 0 ? start : null,
          coveredThroughSeq: end - 1,
        },
      },
    });
  });
  await page.route(/\/rpc\/threads\/markRead(?:\?|$)/, async (route) => {
    const { json: input } = route.request().postDataJSON() as { json: { throughSeq?: number } };
    if (input.throughSeq == null)
      throw new Error("Automatic reads must include a message sequence");
    reads.push(input.throughSeq);
    await route.fulfill({
      json: {
        json: {
          ok: true,
          readState: {
            ...readState,
            lastReadSeq: input.throughSeq,
            unread: input.throughSeq < 139,
          },
        },
      },
    });
  });

  await page.goto(`/app/${bot.id}`);
  await page.bringToFront();
  const transcript = page.getByTestId("transcript");
  await expect(page.getByTestId("unread-divider")).toBeInViewport();
  await expect(transcript.locator('[data-message-id="unread-history-35"]')).toBeInViewport();
  await expect.poll(() => reads.length).toBeGreaterThan(0);
  expect(pages).toEqual([10, 35]);
  expect(Math.max(...reads)).toBeLessThan(60);
  await expect(transcript.locator('[data-message-id="unread-history-139"]')).toHaveCount(0);
  await captureScreenshot(page, testInfo, "chat-unread-history");

  await transcript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => pages).toContain(60);
  await expect(transcript.locator('[data-message-id="unread-history-60"]')).toHaveCount(1);
  await expect(transcript.locator('[data-message-id="unread-history-84"]')).toHaveCount(1);
  await expect(transcript.locator('[data-message-id="unread-history-139"]')).toHaveCount(0);
  expect(Math.max(...reads)).toBeLessThan(85);

  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect(transcript.locator('[data-message-id="unread-history-139"]')).toBeInViewport();
  await expect.poll(() => Math.max(...reads)).toBe(139);
});
