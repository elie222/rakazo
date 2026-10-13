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

for (const historyResult of ["hidden", "failed", "superseded"] as const) {
  test(`reading recovers when the unread history is ${historyResult}`, async ({ page }) => {
    await signup(page, `unread-${historyResult}-${Date.now()}@rakazo.test`, "password12", "Reader");
    await completeOnboarding(page);
    const bot = await rpc<{ id: string }>(page, "bots/create", {
      name: "Unread recovery",
      title: "",
      description: "",
      computerMode: "team",
    });
    const snapshot = await rpc<ThreadSnapshot>(page, "threads/get", { botId: bot.id });
    const message = (seq: number, text: string): ThreadSnapshot["messages"][number] => ({
      id: `recovery-${seq}`,
      threadId: snapshot.threadId,
      botId: bot.id,
      seq,
      role: "bot",
      blocks: [{ kind: "text", text }],
      createdAt: new Date(Date.UTC(2026, 0, 1, 12, seq)).toISOString(),
    });
    const hidden = {
      ...message(10, ""),
      blocks: [{ kind: "steps" as const, steps: [{ label: "Shell", count: 1 }] }],
    };
    let hydrated: ThreadSnapshot = {
      ...snapshot,
      messages:
        historyResult === "hidden"
          ? [message(9, "Previously read note"), hidden]
          : [
              message(40, "Visible latest note"),
              message(41, Array.from({ length: 60 }, (_, i) => `Later detail ${i}`).join("\n\n")),
            ],
      olderCursor: historyResult === "hidden" ? 9 : 40,
      readState: {
        lastReadSeq: 9,
        lastUnreadSeq: historyResult === "hidden" ? 10 : 41,
        unread: true,
      },
    };
    const reads: number[] = [];
    let historyRequests = 0;
    let snapshotRequests = 0;
    let historyCompleted = false;
    let releaseHistory = () => {};
    const pendingHistory = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    await page.route(/\/rpc\/(bootstrap|threads\/get)(?:\?|$)/, async (route) => {
      if (route.request().url().includes("/threads/get")) {
        snapshotRequests += 1;
        await route.fulfill({ json: { json: hydrated } });
        return;
      }
      const response = await route.fetch();
      const body = await response.json();
      body.json.thread = hydrated;
      await route.fulfill({ response, json: body });
    });
    // A closed stream refreshes the snapshot on reconnect, letting this fixture
    // deliver a later reply without sending synthetic messages to the database.
    await page.route(/\/rpc\/threads\/subscribe(?:\?|$)/, (route) =>
      route.fulfill({ contentType: "text/event-stream", body: "" }),
    );
    await page.route(/\/rpc\/threads\/messages(?:\?|$)/, async (route) => {
      historyRequests += 1;
      if (historyResult === "failed") {
        await route.abort("failed");
        return;
      }
      if (historyResult === "superseded") await pendingHistory;
      await route.fulfill({
        json: {
          json: {
            threadId: snapshot.threadId,
            messages:
              historyResult === "superseded"
                ? [message(10, "Older unread note")]
                : hydrated.messages,
            olderCursor: 9,
            coveredThroughSeq: 10,
          },
        },
      });
      historyCompleted = true;
    });
    await page.route(/\/rpc\/threads\/markRead(?:\?|$)/, async (route) => {
      const { json: input } = route.request().postDataJSON() as { json: { throughSeq?: number } };
      if (input.throughSeq == null) throw new Error("Automatic reads must be scoped");
      reads.push(input.throughSeq);
      await route.fulfill({ json: { json: { ok: true } } });
    });

    await page.goto(`/app/${bot.id}`);
    await page.bringToFront();
    await expect.poll(() => historyRequests).toBe(1);
    const transcript = page.getByTestId("transcript");
    await expect(page.getByTestId("unread-divider")).toHaveCount(0);
    if (historyResult !== "hidden") {
      await expect(transcript.locator('[data-message-id="recovery-40"]')).toBeInViewport();
      await expect(transcript.getByText("Later detail 59", { exact: true })).not.toBeInViewport();
      // Scrolling to the tail must neither hide recovery nor consume the missing
      // unread history. Reconnect refreshes leave time for read measurements.
      const previousRequests = snapshotRequests;
      await transcript.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(transcript.getByText("Later detail 59", { exact: true })).toBeInViewport();
      await expect.poll(() => snapshotRequests).toBeGreaterThan(previousRequests + 1);
      expect(reads).toEqual([]);
      const jump = page.getByRole("button", { name: "Jump to latest" });
      await expect(jump).toBeVisible();
      await jump.click();
      await expect.poll(() => reads).toContain(41);
      if (historyResult === "superseded") {
        const requestsBeforeRelease = snapshotRequests;
        releaseHistory();
        await expect.poll(() => historyCompleted).toBe(true);
        await expect.poll(() => snapshotRequests).toBeGreaterThan(requestsBeforeRelease + 1);
        await expect(transcript.locator('[data-message-id="recovery-10"]')).toHaveCount(0);
        await expect(transcript.getByText("Later detail 59", { exact: true })).toBeInViewport();
        await expect(jump).toBeHidden();
      }
    } else {
      await expect(transcript.locator('[data-message-id="recovery-10"]')).toHaveCount(0);
      expect(reads).toEqual([]);
      hydrated = {
        ...hydrated,
        cursor: hydrated.cursor + 1,
        messages: [...hydrated.messages, message(11, "A later visible reply")],
        readState: { lastReadSeq: 9, lastUnreadSeq: 11, unread: true },
      };
      await expect(transcript.locator('[data-message-id="recovery-11"]')).toBeInViewport();
      await expect.poll(() => reads).toContain(11);
      expect(reads).not.toContain(10);
    }
  });
}
