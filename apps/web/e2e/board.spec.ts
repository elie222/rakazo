import { expect, type Page, test } from "@playwright/test";
import type { BoardItem, Bot, Routine, UpcomingRoutine } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("board page shows in-flight columns", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `board-${stamp}@rakazo.test`, "password12", "Board User");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);

  const scout = await rpc<Bot>(page, "bots/create", {
    name: "Scout",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  });

  await rpc<Routine>(page, "routines/create", {
    botId: chiefId,
    name: "Morning brief",
    prompt: "Summarize overnight inbox",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: true,
    notify: true,
  });

  await rpc(page, "threads/send", {
    botId: chiefId,
    text: "keep working until I stop you",
  });
  await waitForRunStatus(page, chiefId, "running");

  await rpc(page, "threads/send", {
    botId: scout.id,
    text: "ask me which city to use",
  });
  await waitForRunStatus(page, scout.id, "waiting_input");

  await expect
    .poll(async () => {
      const board = await rpc<{ items: BoardItem[]; upcoming: UpcomingRoutine[] }>(
        page,
        "board/list",
        {},
      );
      return {
        working: board.items.some((item) => item.status === "running" && item.botId === chiefId),
        needsYou: board.items.some(
          (item) => item.status === "waiting_input" && item.botId === scout.id,
        ),
        upcoming: board.upcoming.some((routine) => routine.name === "Morning brief"),
      };
    })
    .toEqual({ working: true, needsYou: true, upcoming: true });

  await page.goto("/app/board");
  await expect(page.getByRole("heading", { name: "Board", exact: true })).toBeVisible();
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  await expect(page.getByText("Working", { exact: true })).toBeVisible();
  await expect(page.getByText("Needs you", { exact: true })).toBeVisible();
  await expect(page.getByText("Upcoming", { exact: true })).toBeVisible();
  await expect(page.getByText("Chief").first()).toBeVisible();
  await expect(page.getByText("Scout").first()).toBeVisible();
  await expect(page.getByText("Morning brief")).toBeVisible();
  await captureScreenshot(page, testInfo, "board-page");

  await rpc(page, "threads/stop", { botId: chiefId });
});

async function waitForRunStatus(page: Page, botId: string, status: string) {
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 30_000 },
    )
    .toBe(status);
}
