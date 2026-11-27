import { expect, test } from "@playwright/test";
import { createDb, createThreadMessage, runAsSystem } from "@rakazo/db";
import { captureScreenshot, completeOnboarding, rpc, signup } from "../helpers/helpers";

test("collapses consecutive handoffs and peer receipts in a group chat", async ({
  page,
}, testInfo) => {
  await signup(page, `group-collaboration-${Date.now()}@rakazo.test`, "password12", "Demo");
  await completeOnboarding(page);
  const lead = await rpc<{ id: string; name: string }>(page, "bots/create", { name: "Lead" });
  const peers: Array<{ id: string; name: string; text: string }> = [];
  for (const [name, text] of [
    ["Researcher", "The research notes are ready."],
    ["Writer", "The launch draft is ready."],
    ["Reviewer", "The final review is complete."],
  ] as const) {
    const bot = await rpc<{ id: string; name: string }>(page, "bots/create", { name });
    peers.push({ ...bot, text });
  }
  const receiptPeers = peers.slice(0, 2);
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Launch team",
    botIds: [lead.id, ...peers.map((peer) => peer.id)],
  });

  const { prisma, pool } = createDb(process.env.DATABASE_URL!);
  try {
    await runAsSystem("seed group collaboration screenshot", async () => {
      const thread = await prisma.thread.findUniqueOrThrow({ where: { groupId: group.id } });
      for (const peer of peers) {
        await createThreadMessage(prisma, {
          threadId: thread.id,
          role: "bot",
          botId: peer.id,
          blocks: [{ kind: "handoff", fromBotId: peer.id, toBotId: lead.id, text: peer.text }],
        });
      }
      for (const peer of receiptPeers) {
        await createThreadMessage(prisma, {
          threadId: thread.id,
          role: "bot",
          botId: lead.id,
          blocks: [
            { kind: "bot_message_sent", toBotId: peer.id, toBotName: peer.name, text: "Thanks!" },
          ],
        });
      }
    });
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }

  await page.goto(`/app/g/${group.id}`);
  const transcript = page.getByTestId("transcript");
  const handoffChip = transcript.getByTestId("handoff-group-chip");
  const peerChip = transcript.getByTestId("peer-group-chip");
  const details = transcript.getByTestId("handoff-group-details");
  const links = transcript.getByTestId("peer-group-links");
  await expect(handoffChip).toHaveCount(1);
  await expect(handoffChip).toHaveAccessibleName("Messaged 3 Bots");
  await expect(handoffChip).toBeInViewport();
  await expect(peerChip).toHaveCount(1);
  await expect(peerChip).toHaveAccessibleName("Messaged 2 Bots");
  await expect(peerChip).toBeInViewport();
  await expect(details).toBeHidden();
  await expect(links).toBeHidden();
  await captureScreenshot(page, testInfo, "group-collaboration-collapsed");

  await handoffChip.click();
  await expect(details).toBeVisible();
  for (const peer of peers) {
    await expect(details.getByText(`${peer.name} → ${lead.name}`, { exact: true })).toBeVisible();
    await expect(details.getByText(peer.text, { exact: true })).toBeVisible();
  }
  await captureScreenshot(page, testInfo, "group-handoffs-expanded");

  await handoffChip.click();
  await expect(details).toBeHidden();
  await peerChip.click();
  await expect(links).toBeVisible();
  for (const peer of receiptPeers) {
    await expect(links.getByRole("button", { name: peer.name, exact: true })).toBeVisible();
  }
  await captureScreenshot(page, testInfo, "group-peer-links-expanded");
});
