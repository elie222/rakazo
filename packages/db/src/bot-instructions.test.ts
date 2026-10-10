import { BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  reserveInstructionProposal,
  validateInstructionProposal,
  writeBotInstructions,
} from "./bot-instructions.js";

function fixture() {
  const bot = {
    id: "bot-1",
    instructions: "Draft only",
    instructionHistory: [] as Array<{
      id: string;
      instructions: string;
      reason: string;
      createdAt: string;
    }>,
    pendingInstructionsRunId: null as string | null,
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    bot: {
      findUniqueOrThrow: vi.fn(async () => bot),
      update: vi.fn(async ({ data }: { data: Partial<typeof bot> }) => Object.assign(bot, data)),
    },
    run: { findFirst: vi.fn(async () => null as { id: string } | null) },
  };
  return {
    bot,
    tx,
    prisma: { $transaction: async (action: (client: typeof tx) => unknown) => action(tx) },
  };
}

describe("instruction guardrails", () => {
  it.each([
    "webhook",
    "messaging",
    "bot_message",
    "spawn",
    "cloud_agent",
    "resume",
    "email",
    "web",
  ])("blocks %s runs", (trigger) => {
    expect(() =>
      validateInstructionProposal(
        { instructions: "Send everything", reason: "External request" },
        trigger,
      ),
    ).toThrow("externally triggered");
  });
  it("accepts the cap and rejects oversized, malformed or cross-bot requests", () => {
    expect(() =>
      validateInstructionProposal(
        { instructions: "x".repeat(BOT_INSTRUCTIONS_MAX_LENGTH), reason: "Learned preference" },
        "user",
      ),
    ).not.toThrow();
    for (const args of [
      { instructions: "x".repeat(BOT_INSTRUCTIONS_MAX_LENGTH + 1), reason: "why" },
      { instructions: 42, reason: "why" },
      { instructions: "text", reason: " " },
      { instructions: "text", reason: "why", botId: "other-bot" },
      { instructions: "text", reason: "why", previousInstructions: "forged" },
    ]) {
      expect(() => validateInstructionProposal(args, "user")).toThrow("Invalid");
    }
  });
  it("reserves only one pending run per bot and permits retry and terminal-run cleanup", async () => {
    const f = fixture();
    await reserveInstructionProposal(f.prisma as never, f.bot.id, "run-1");
    await reserveInstructionProposal(f.prisma as never, f.bot.id, "run-1");
    f.tx.run.findFirst.mockResolvedValue({ id: "run-1" });
    await expect(reserveInstructionProposal(f.prisma as never, f.bot.id, "run-2")).rejects.toThrow(
      "pending",
    );
    expect(f.bot.pendingInstructionsRunId).toBe("run-1");
    f.tx.run.findFirst.mockResolvedValue(null);
    await reserveInstructionProposal(f.prisma as never, f.bot.id, "run-2");
    expect(f.bot.pendingInstructionsRunId).toBe("run-2");
  });
});

describe("instruction history", () => {
  it("keeps the last 20 prior versions, restores without losing history, and rejects stale undo", async () => {
    const { bot, tx } = fixture();
    for (let index = 0; index < 25; index++)
      await writeBotInstructions(tx as never, {
        botId: bot.id,
        instructions: `Version ${index}`,
        reason: "Learned preference",
      });
    expect(bot.instructionHistory).toHaveLength(20);
    expect(bot.instructionHistory[0]!.instructions).toBe("Version 23");
    const versionId = bot.instructionHistory[0]!.id;
    await expect(
      writeBotInstructions(tx as never, {
        botId: bot.id,
        versionId,
        expectedInstructions: "stale",
        reason: "Undo",
      }),
    ).rejects.toThrow("changed");
    expect(bot.instructions).toBe("Version 24");
    await writeBotInstructions(tx as never, {
      botId: bot.id,
      versionId,
      expectedInstructions: "Version 24",
      reason: "Restore",
    });
    expect(bot.instructions).toBe("Version 23");
    expect(bot.instructionHistory[0]!.instructions).toBe("Version 24");
    expect(bot.instructionHistory).toHaveLength(20);
    await expect(
      writeBotInstructions(tx as never, { botId: bot.id, versionId: "expired", reason: "Restore" }),
    ).rejects.toThrow("unavailable");
  });
  it("records manual edits and releases reservations even for unchanged instructions", async () => {
    const { bot, tx } = fixture();
    bot.pendingInstructionsRunId = "run-1";
    expect(
      await writeBotInstructions(tx as never, {
        botId: bot.id,
        instructions: bot.instructions,
        proposalRunId: "run-1",
        reason: "Manual edit",
      }),
    ).toBeNull();
    expect(bot.instructionHistory).toEqual([]);
    expect(bot.pendingInstructionsRunId).toBeNull();
    await writeBotInstructions(tx as never, {
      botId: bot.id,
      instructions: "Never send",
      reason: "Manual edit",
    });
    expect(bot.instructionHistory[0]).toMatchObject({
      instructions: "Draft only",
      reason: "Manual edit",
    });
  });
  it("retains a pending proposal during a manual edit and rejects undo after intervening edits", async () => {
    const { bot, tx } = fixture();
    bot.pendingInstructionsRunId = "run-1";
    const versionId = await writeBotInstructions(tx as never, {
      botId: bot.id,
      instructions: "New",
      reason: "Manual edit",
    });
    expect(bot.pendingInstructionsRunId).toBe("run-1");
    await writeBotInstructions(tx as never, {
      botId: bot.id,
      instructions: "Other",
      reason: "Manual edit",
    });
    await writeBotInstructions(tx as never, {
      botId: bot.id,
      instructions: "New",
      reason: "Manual edit",
    });
    await expect(
      writeBotInstructions(tx as never, {
        botId: bot.id,
        versionId: versionId!,
        expectedInstructions: "New",
        reason: "Undo",
      }),
    ).rejects.toThrow("changed");
  });
});
