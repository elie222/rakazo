import { expect, test } from "@playwright/test";
import {
  appendEventInTransaction,
  createDb,
  createThreadMessageInTransaction,
} from "../../../packages/db/src/index";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("delegated work stays working and stoppable with a newer queued run", async ({
  page,
}, testInfo) => {
  await signup(page, `working-bot-${Date.now()}@example.test`, "password12", "Demo");
  await completeOnboarding(page);
  const bot = await rpc<{ id: string; threadId: string }>(page, "bots/create", {
    name: "Research Helper",
    title: "",
    description: "",
    computerMode: "team",
  });
  const { prisma, pool } = createDb(process.env.DATABASE_URL!);
  try {
    const stored = await prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      include: { thread: true },
    });
    const threadId = stored.thread!.id;
    const scope = { spaceId: stored.spaceId, botId: bot.id, threadId, userId: stored.userId };
    const task = await prisma.task.create({
      data: { ...scope, prompt: "Inspect the sample files", status: "running" },
    });
    const running = await prisma.run.create({
      data: {
        ...scope,
        taskId: task.id,
        trigger: "bot_message",
        status: "running",
        startedAt: new Date(),
        createdAt: new Date(Date.now() - 1000),
        leaseExpiresAt: new Date(Date.now() + 600_000),
      },
    });
    // Keep reconciled queued work waiting behind the running fixture's computer lease.
    await prisma.computerExecutionLease.create({
      data: {
        computerId: stored.computerId!,
        botId: bot.id,
        runId: running.id,
        fence: 1,
        expiresAt: running.leaseExpiresAt!,
      },
    });
    const queuedTask = await prisma.task.create({
      data: { ...scope, prompt: "Inspect the next sample", status: "queued" },
    });
    const queued = await prisma.run.create({
      data: {
        ...scope,
        taskId: queuedTask.id,
        trigger: "user",
        status: "queued",
      },
    });
    await prisma.$transaction((tx) =>
      createThreadMessageInTransaction(tx, {
        threadId,
        botId: bot.id,
        role: "bot",
        runId: running.id,
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "sample-peer",
            fromBotName: "Writing Helper",
            text: "Inspect the sample files",
          },
        ],
      }),
    );
    await page.evaluate(() => localStorage.setItem("rakazo.responseStreaming", "on"));
    await prisma.$transaction((tx) =>
      appendEventInTransaction(tx, {
        ...scope,
        runId: running.id,
        type: "thread.progress",
        payload: { text: "Inspecting the sample files" },
      }),
    );
    await page.goto(`/app/${bot.id}`);
    const row = page.locator(`[data-roster-bot-id="${bot.id}"]`);
    await expect(row.getByText("Working…", { exact: true })).toBeVisible();
    await expect(row).not.toContainText("Waiting in line…");
    const sidebarShot = testInfo.outputPath("working-bot-sidebar.png");
    await row.screenshot({ path: sidebarShot, animations: "disabled", caret: "hide" });
    await testInfo.attach("working-bot-sidebar", { path: sidebarShot, contentType: "image/png" });
    await expect(page.getByText("Inspecting the sample files", { exact: true })).toHaveCount(0);
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeVisible();
    await captureScreenshot(page, testInfo, "working-bot-stop");
    await stop.click();
    await expect
      .poll(async () =>
        (
          await prisma.run.findMany({
            where: { id: { in: [running.id, queued.id] } },
            select: { status: true },
          })
        ).map((run) => run.status),
      )
      .toEqual(["cancelled", "cancelled"]);
    await expect(stop).toBeHidden();
  } finally {
    await rpc(page, "threads/stop", { botId: bot.id }).catch(() => undefined);
    await prisma.$disconnect();
    await pool.end();
  }
});
