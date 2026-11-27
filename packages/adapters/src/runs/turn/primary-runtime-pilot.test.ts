import { afterEach, expect, it, vi } from "vitest";
import {
  groupPilotRuntimeForBot,
  loadPilotRuntime,
  pilotConversation,
  pilotGroupRequest,
  pilotRunModel,
  pilotRuntimeForBot,
} from "./primary-runtime-pilot.js";

const bot = {
  modelProvider: "anthropic",
  modelId: "claude-sonnet-4-6",
  modelCredentialId: "key-a",
};
const id = pilotRuntimeForBot("bot", { PRIMARY_RUNTIME_PILOT_BOT_IDS: "bot" })!;
const run = { ...pilotRunModel(id, bot)!, botId: "bot", trigger: "user", routineId: null };
const model = {
  provider: bot.modelProvider,
  id: bot.modelId,
  connectionId: bot.modelCredentialId,
  apiKey: "fixture-key",
  billing: "api_key" as const,
};

afterEach(() => vi.unstubAllEnvs());

it("keeps an unlisted bot on its unchanged path and refuses an unpinned pilot bot", () => {
  expect(pilotRuntimeForBot("other-bot", { PRIMARY_RUNTIME_PILOT_BOT_IDS: "bot" })).toBeUndefined();
  expect(pilotRunModel(id, { ...bot, modelCredentialId: null })).toBeUndefined();
});

it("rejects changed credentials rather than resolving another account", async () => {
  vi.stubEnv("PRIMARY_RUNTIME_PILOT_BOT_IDS", run.botId);
  vi.stubEnv("PRIMARY_RUNTIME_PILOT_LAUNCHER", process.execPath);
  await expect(loadPilotRuntime(run, { ...model, connectionId: "key-b" })).rejects.toThrow(
    "exact API-key connection",
  );
});

it("rejects a queued pilot turn after operator enrolment was removed", async () => {
  vi.stubEnv("PRIMARY_RUNTIME_PILOT_BOT_IDS", "");
  vi.stubEnv("PRIMARY_RUNTIME_PILOT_LAUNCHER", process.execPath);
  await expect(loadPilotRuntime(run, model)).rejects.toThrow("exact API-key connection");
});

it("projects only prior plain text in the owner's app DM; group markers never run", () => {
  const run = { botId: "bot", userId: "owner", sourceMessageId: "current" };
  const bot = { userId: "owner" };
  const thread = { botId: "bot", groupId: null, externalConversationId: null };
  const make = (id: string, seq: number, text: string) => ({
    id,
    seq,
    role: "user",
    authorUserId: "owner",
    botId: null,
    blocks: [{ kind: "text", text }],
  });
  const messages = [
    make("current", 4, "new question"),
    make("future", 5, "not yet visible"),
    { ...make("other", 1, "another member's text"), authorUserId: "other" },
    { ...make("media", 2, "caption"), blocks: [{ kind: "file", artifactId: "raw" }] },
    make("prior", 3, "last question"),
  ];
  expect(pilotConversation(run, thread, bot, messages)).toEqual({
    prompt: "new question",
    history: [{ id: "prior", role: "user", content: "last question" }],
  });
  expect(() => pilotConversation(run, { ...thread, groupId: "group" }, bot, messages)).toThrow(
    "only supports the bot owner's plain text chat",
  );
});

it("leaves group delivery off without independent enrolment", () => {
  expect(groupPilotRuntimeForBot("bot", { PRIMARY_RUNTIME_PILOT_BOT_IDS: "bot" })).toBeUndefined();
  expect(
    groupPilotRuntimeForBot("bot", { PRIMARY_RUNTIME_PILOT_GROUP_BOT_IDS: "bot" }),
  ).toBeUndefined();
});

it("builds a fresh group request from the exact source, with no history, reply quote or secret bag", async () => {
  vi.stubEnv("PRIMARY_RUNTIME_PILOT_BOT_IDS", run.botId);
  vi.stubEnv("PRIMARY_RUNTIME_PILOT_GROUP_BOT_IDS", run.botId);
  const input = {
    run: {
      ...run,
      id: "run-a",
      userId: "owner",
      spaceId: "space",
      threadId: "thread",
      sourceMessageId: "current",
    },
    thread: { id: "thread", botId: null, groupId: "group", externalConversationId: null },
    model,
    onUsage: undefined,
    redactions: ["hidden-credential"],
  };
  const prisma = {
    message: {
      findFirst: vi.fn().mockResolvedValue({
        blocks: [{ kind: "text", text: "Respond only to this message." }],
        replyQuote: "Private earlier conversation",
        secrets: ["another bot credential"],
      }),
    },
  };
  await expect(pilotGroupRequest(prisma as never, input)).resolves.toEqual({
    botId: "bot",
    threadId: "thread",
    runId: "run-a",
    sourceMessageId: "current",
    prompt: "Respond only to this message.",
    history: [],
    instructions: "",
    model,
    onUsage: undefined,
    tools: [],
  });
  expect(prisma.message.findFirst).toHaveBeenCalledExactlyOnceWith({
    where: {
      id: "current",
      threadId: "thread",
      authorUserId: "owner",
      role: "user",
      thread: {
        groupId: "group",
        spaceId: "space",
        externalConversationId: null,
        group: {
          spaceId: "space",
          archivedAt: null,
          members: {
            some: {
              botId: "bot",
              bot: { spaceId: "space", userId: "owner", archivedAt: null },
            },
          },
        },
      },
    },
    select: { id: true, threadId: true, blocks: true },
  });
  await expect(
    pilotGroupRequest(prisma as never, {
      ...input,
      run: { ...input.run, trigger: "follow_up" },
    }),
  ).rejects.toThrow("addressed text");
  prisma.message.findFirst.mockResolvedValueOnce(null);
  await expect(pilotGroupRequest(prisma as never, input)).rejects.toThrow("addressed text");
  prisma.message.findFirst.mockResolvedValueOnce({
    blocks: [
      { kind: "text", text: "caption" },
      { kind: "file", artifactId: "private" },
    ],
  });
  await expect(pilotGroupRequest(prisma as never, input)).rejects.toThrow("addressed text");
});
