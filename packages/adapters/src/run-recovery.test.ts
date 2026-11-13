import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { findRunRecoveryBlockers } from "./run-recovery.js";

describe("run recovery blockers", () => {
  it("lets a background helper start while the bot's own turn holds the computer", async () => {
    const now = new Date();
    // A live turn's own lease, not a takeover hold.
    const expiresAt = new Date(now.getTime() + 60_000);
    const prisma = {
      computerExecutionLease: {
        findMany: vi.fn(async () => [
          { computerId: "computer", botId: "bot", runId: "chat-turn", expiresAt },
        ]),
      },
    } as unknown as PrismaClient;
    const run = (id: string, trigger: string) => ({
      id,
      botId: "bot",
      trigger,
      bot: { computerId: "computer" },
    });
    const blockers = await findRunRecoveryBlockers(
      prisma,
      [run("next-turn", "user"), run("helper", "helper")],
      now,
    );
    expect([...blockers]).toEqual([["next-turn", "chat-turn"]]);
  });

  it("holds bot messages and routines back while a person's run waits for the same bot", async () => {
    const now = new Date();
    const waitingForPeople = vi.fn(async () => [{ id: "chat", botId: "bot" }]);
    const prisma = {
      computerExecutionLease: { findMany: vi.fn(async () => []) },
      run: { findMany: waitingForPeople },
    } as unknown as PrismaClient;
    const run = (id: string, trigger: string, botId = "bot") => ({
      id,
      botId,
      trigger,
      bot: { computerId: "computer" },
    });
    const blockers = await findRunRecoveryBlockers(
      prisma,
      [
        run("peer-message", "bot_message"),
        run("chat", "user"),
        run("nightly", "routine"),
        run("other-bot-peer-message", "bot_message", "other-bot"),
      ],
      now,
    );
    expect([...blockers]).toEqual([
      ["peer-message", "chat"],
      ["nightly", "chat"],
    ]);
    expect(waitingForPeople).toHaveBeenCalledExactlyOnceWith({
      where: {
        botId: { in: ["bot", "other-bot"] },
        status: "queued",
        trigger: { notIn: ["bot_message", "routine", "reaction", "helper"] },
        OR: [{ wakeAt: null }, { wakeAt: { lte: now } }],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      distinct: ["botId"],
      select: { id: true, botId: true },
    });
  });

  it("lets a routine that still holds the computer start while a person's run waits on it", async () => {
    const now = new Date();
    const waitingForPeople = vi.fn(async () => [{ id: "chat", botId: "bot" }]);
    const prisma = {
      computerExecutionLease: {
        findMany: vi.fn(async () => [
          {
            computerId: "computer",
            botId: "bot",
            runId: "held-routine",
            expiresAt: new Date(now.getTime() + 60_000),
          },
        ]),
      },
      run: { findMany: waitingForPeople },
    } as unknown as PrismaClient;
    const run = (id: string, trigger: string) => ({
      id,
      botId: "bot",
      trigger,
      bot: { computerId: "computer" },
    });
    const blockers = await findRunRecoveryBlockers(
      prisma,
      [run("held-routine", "routine"), run("chat", "user")],
      now,
    );
    expect([...blockers]).toEqual([["chat", "held-routine"]]);
    expect(waitingForPeople).not.toHaveBeenCalled();
  });
});
