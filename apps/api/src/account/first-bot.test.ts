import type { Actor, Bot } from "@rakazo/contracts";
import { FIRST_BOT_SPAWN_KEY } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { FirstBotDeps } from "./first-bot.js";
import { ensureFirstBot } from "./first-bot.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};

type Row = { id: string };

function fixture(
  options: {
    candidates?: { id: string; spawnKey: string | null }[];
    bot?: Row;
    group?: Row;
    deletion?: Row;
    created?: string;
    madeSpaces?: string[];
  } = {},
) {
  const deps = {
    prisma: {
      bot: {
        findMany: vi.fn(async () => options.candidates ?? []),
        findFirst: vi.fn(async () => options.bot ?? null),
      },
      chatGroup: { findFirst: vi.fn(async () => options.group ?? null) },
      space: {
        findMany: vi.fn(async () => (options.madeSpaces ?? []).map((id) => ({ id }))),
      },
      botDeletion: { findFirst: vi.fn(async () => options.deletion ?? null) },
    },
    createBot: vi.fn(
      async (_actor: Actor, _input: { spawnKey?: string }) =>
        ({ id: options.created ?? "chief-new" }) as Bot,
    ),
    introduce: vi.fn(async () => undefined),
    promptFocus: vi.fn(async () => undefined),
  };
  return { deps, run: () => ensureFirstBot(deps as unknown as FirstBotDeps, actor) };
}

describe("ensureFirstBot", () => {
  it("creates and greets Chief in a Space that never held a chat", async () => {
    const { deps, run } = fixture();
    await expect(run()).resolves.toEqual({ botId: "chief-new" });
    expect(deps.createBot).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ name: "Chief", spawnKey: FIRST_BOT_SPAWN_KEY }),
    );
    expect(deps.introduce).toHaveBeenCalledWith(actor, { id: "chief-new" });
    expect(deps.promptFocus).toHaveBeenCalledWith(actor, "chief-new");
    // The card checks for the intro run, so the run is committed first.
    expect(deps.introduce.mock.invocationCallOrder[0]).toBeLessThan(
      deps.promptFocus.mock.invocationCallOrder[0]!,
    );
  });

  it("reuses the bot with the first-run key before a legacy Chief", async () => {
    const { deps, run } = fixture({
      candidates: [
        { id: "legacy", spawnKey: null },
        { id: "keyed", spawnKey: FIRST_BOT_SPAWN_KEY },
      ],
    });
    await expect(run()).resolves.toEqual({ botId: "keyed" });
    expect(deps.createBot).not.toHaveBeenCalled();
    // Whoever created it greets it, so a found Chief's thread is left alone.
    expect(deps.introduce).not.toHaveBeenCalled();
    expect(deps.promptFocus).not.toHaveBeenCalled();
  });

  it("reuses a Chief made before the first-run key existed", async () => {
    const { deps, run } = fixture({ candidates: [{ id: "legacy", spawnKey: null }] });
    await expect(run()).resolves.toEqual({ botId: "legacy" });
    expect(deps.createBot).not.toHaveBeenCalled();
    expect(deps.prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: "space-1",
          archivedAt: null,
          OR: [{ spawnKey: FIRST_BOT_SPAWN_KEY }, { name: "Chief" }],
        },
      }),
    );
  });

  it.each([
    ["deleted bots", { deletion: { id: "gone" } }],
    ["other or archived bots", { bot: { id: "scout" } }],
    ["a group", { group: { id: "standup" } }],
  ])("never brings Chief back to a Space with %s", async (_name, history) => {
    const { deps, run } = fixture(history);
    await expect(run()).resolves.toEqual({ botId: null });
    expect(deps.createBot).not.toHaveBeenCalled();
    expect(deps.promptFocus).not.toHaveBeenCalled();
  });

  it("looks for earlier chats in every Space the person made", async () => {
    // A new Space or organization starts empty once the person has chatted in one they made.
    const { deps, run } = fixture({ madeSpaces: ["space-1", "team-space"], bot: { id: "scout" } });
    await expect(run()).resolves.toEqual({ botId: null });
    const where = { spaceId: { in: ["space-1", "space-1", "team-space"] } };
    expect(deps.prisma.bot.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(deps.prisma.chatGroup.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where }),
    );
    expect(deps.prisma.botDeletion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where }),
    );
    expect(deps.prisma.space.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { createdByUserId: "user-1", memberships: { some: { userId: "user-1" } } },
      }),
    );
    expect(deps.createBot).not.toHaveBeenCalled();
  });

  it("returns the bot a concurrent first load created", async () => {
    // The repository answers a lost (spaceId, spawnKey) race with the winner.
    const { deps, run } = fixture({ created: "winner" });
    const [first, second] = await Promise.all([run(), run()]);
    expect(first).toEqual({ botId: "winner" });
    expect(second).toEqual({ botId: "winner" });
    expect(
      deps.createBot.mock.calls.every(([, input]) => input.spawnKey === FIRST_BOT_SPAWN_KEY),
    ).toBe(true);
  });

  it("finds the Chief another call made between its two reads", async () => {
    const { deps, run } = fixture({ bot: { id: "chief-other" } });
    deps.prisma.bot.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "chief-other", spawnKey: FIRST_BOT_SPAWN_KEY }]);
    await expect(run()).resolves.toEqual({ botId: "chief-other" });
    expect(deps.createBot).not.toHaveBeenCalled();
    expect(deps.promptFocus).not.toHaveBeenCalled();
  });

  it("still opens Chief when greeting it fails", async () => {
    const { deps, run } = fixture();
    deps.introduce.mockRejectedValue(new Error("queue down"));
    deps.promptFocus.mockRejectedValue(new Error("db down"));
    await expect(run()).resolves.toEqual({ botId: "chief-new" });
  });
});
