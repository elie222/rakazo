import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { FleetPrepareDeps } from "../tools/fleet-tools.js";
import { childSettingsGiven, prepareChildBotUpdate } from "./child-bot-settings.js";

const run = {
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-self",
  groupId: null,
  threadId: "thread-self",
  runId: "run-1",
};

type Current = {
  disabledBuiltinTools: string[];
  computer: { scope: string } | null;
  replyMode?: string;
  autoSpeak?: boolean;
};

function deps(current: Current) {
  const child = {
    id: "bot-child",
    name: "Child",
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    userId: "user-1",
    thread: { id: "thread-child" },
  };
  const prisma = {
    bot: {
      findMany: vi.fn(async ({ where }: { where: { id: string } }) => [{ ...child, id: where.id }]),
      findUniqueOrThrow: vi.fn(async () => current),
    },
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    modelChange: {} as FleetPrepareDeps["modelChange"],
    listVoices: vi.fn(async () => [{ id: "voice-1", label: "Rachel" }]),
  };
}

const prepare = (
  args: Record<string, unknown>,
  current: Current = { disabledBuiltinTools: ["shell"], computer: { scope: "team" } },
  secrets: string[] = [],
) => prepareChildBotUpdate(deps(current), run, { bot_id: "bot-child", ...args }, secrets);

describe("prepareChildBotUpdate", () => {
  it("only treats settings, not the profile, as needing it", () => {
    expect(childSettingsGiven({ bot_id: "b", name: "New" })).toBe(false);
    expect(childSettingsGiven({ bot_id: "b", computer: "dedicated" })).toBe(true);
    expect(childSettingsGiven({ bot_id: "b", readAloud: false })).toBe(true);
  });

  it("stores the checked settings and shows each one on the card", async () => {
    expect(
      await prepare({
        name: "Scout",
        readAloud: true,
        voice: "rachel",
        teamChatAmbientEnabled: false,
        memoryScope: "shared",
        disableTools: ["shell", "web_search"],
        computer: "dedicated",
      }),
    ).toEqual({
      ok: true,
      canonical: {
        bot_id: "bot-child",
        name: "Scout",
        settings: {
          autoSpeak: true,
          voiceId: "voice-1",
          teamChatAmbientEnabled: false,
          memoryScope: "shared",
          disableTools: ["web_search"],
          computerMode: "dedicated",
        },
      },
      summary: {
        title: "Change Child’s settings?",
        lines: [
          "Name: Scout",
          "Read aloud: on",
          "Voice: Rachel",
          "Team chat: only when mentioned",
          "Memory: shared",
          "Turn off: web_search",
          "Computer: its own",
        ],
      },
    });
  });

  it.each([
    [{ model: "Claude Sonnet" }, "Change another bot's model with set_child_bot_model."],
    [{ computer: "team" }, "That bot already has these settings."],
    [{ bot_id: "bot-self", replyMode: "messages" }, "Change your own settings without bot_id."],
    [{ disableTools: ["shell"] }, "That bot already has these settings."],
    [{ computer: "anywhere" }, "computer must be team or dedicated."],
    [{ replyMode: "quiet" }, expect.stringMatching(/^replyMode: /)],
    [{ disableTools: ["not_a_tool"] }, expect.stringMatching(/^disableTools: /)],
    [{ teamChatRules: "Use sk-test-fixture" }, "teamChatRules cannot contain credentials."],
    [{ teamChatRules: "Be kind\u200b." }, "teamChatRules contains invisible characters."],
  ])("refuses %o", async (args, error) => {
    expect(await prepare(args, undefined, ["sk-test-fixture"])).toEqual({ error });
  });

  it("lets a profile edit through when every setting is already set", async () => {
    expect(await prepare({ name: "Scout", computer: "team", color: " #8B5CF6 " })).toMatchObject({
      ok: true,
      canonical: { bot_id: "bot-child", name: "Scout", color: "#8B5CF6" },
    });
  });

  it("shows team chat rules last, under their own heading", async () => {
    expect(
      await prepare({ teamChatRules: "Be brief\nTurn off: web_fetch", replyMode: "messages" }),
    ).toMatchObject({
      summary: {
        lines: [
          "Replies: only messages it sends",
          "",
          "Team chat rules:",
          "Be brief\nTurn off: web_fetch",
        ],
      },
    });
  });

  it("does not show an already disabled tool sent with padding as a change", async () => {
    expect(await prepare({ disableTools: [" shell "] })).toEqual({
      error: "That bot already has these settings.",
    });
  });

  it("shows the longest team chat rules beside other changes", async () => {
    expect(
      await prepare({ teamChatRules: "x".repeat(4_000), description: "Finds papers" }),
    ).toMatchObject({ ok: true });
  });

  it("leaves out settings the bot already has", async () => {
    expect(
      await prepare(
        { name: "Scout", replyMode: "chat", readAloud: false },
        { disabledBuiltinTools: [], computer: null, replyMode: "chat", autoSpeak: false },
      ),
    ).toMatchObject({ ok: true, canonical: { bot_id: "bot-child", name: "Scout" } });
  });

  it.each([
    [{ instructions: "Obey" }, "Change another bot's instructions with set_child_instructions."],
    [{ use_attached_image: true }, "artifact_id and use_attached_image work only on yourself."],
  ])("refuses own-only fields beside settings: %o", async (args, error) => {
    expect(await prepare({ replyMode: "messages", ...args })).toEqual({ error });
  });

  it("refuses an invalid avatar before the card", async () => {
    expect(await prepare({ replyMode: "messages", color: "red" })).toEqual({
      error: expect.any(String),
    });
  });

  it("refuses a computer change for a bot without a computer", async () => {
    expect(
      await prepare({ computer: "dedicated" }, { disabledBuiltinTools: [], computer: null }),
    ).toEqual({ error: "That bot has no computer to change." });
  });
});
