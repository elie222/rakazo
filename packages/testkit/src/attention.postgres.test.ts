import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AttentionListOutput } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createThreadMessage } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeAttention = hasDb ? describe : describe.skip;

describeAttention("attention.list", () => {
  let app: App;
  let prisma: PrismaClient;
  let stop: () => Promise<void>;
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-attention-"));

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    });
    app = handles.app;
    prisma = asSystem(handles.prisma);
    stop = handles.stop;
  });

  afterAll(async () => {
    await stop?.();
  });

  it("returns one typed item per waiting card, failure and delayed routine", async () => {
    const cookie = await signup(app, `attention-${stamp}@rakazo.test`, "Attention User");
    const questionBot = await createBot(app, cookie, "Question Bot");
    const approvalBot = await createBot(app, cookie, "Approval Bot");
    const takeoverBot = await createBot(app, cookie, "Takeover Bot");
    const failedBot = await createBot(app, cookie, "Failed Bot");
    const routineBot = await createBot(app, cookie, "Routine Bot");
    const secretBot = await createBot(app, cookie, "Secret Bot");
    const otherMemberBot = await createBot(app, cookie, "Other Member Bot");

    const question = await seedRun(prisma, questionBot.id, "waiting_input", "pick a city");
    const questionMessage = await createThreadMessage(prisma, {
      threadId: question.threadId,
      role: "bot",
      botId: questionBot.id,
      runId: question.id,
      blocks: [
        {
          kind: "ask",
          text: "Which city should I use?",
          status: "pending",
          actions: [
            { id: "choice-1", label: "Berlin" },
            { id: "choice-2", label: "Seoul" },
          ],
        },
      ],
    });

    const approval = await seedRun(prisma, approvalBot.id, "waiting_input", "read that page");
    const approvalMessage = await createThreadMessage(prisma, {
      threadId: approval.threadId,
      role: "bot",
      botId: approvalBot.id,
      runId: approval.id,
      blocks: [
        {
          kind: "ask",
          text: "Read https://docs.example.test/page?q=fixture?",
          status: "pending",
          approvalEffectId: "effect-1",
          site: "docs.example.test",
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "always", label: "Always allow docs.example.test" },
            { id: "deny", label: "Deny" },
          ],
        },
      ],
    });

    const takeover = await seedRun(prisma, takeoverBot.id, "waiting_takeover", "sign in");
    const secret = await seedRun(prisma, secretBot.id, "waiting_input", "save a login");
    const secretMessage = await createThreadMessage(prisma, {
      threadId: secret.threadId,
      role: "bot",
      botId: secretBot.id,
      runId: secret.id,
      blocks: [
        {
          kind: "ask",
          text: "i need that value in a protected field.",
          status: "pending",
          input: "secret",
        },
      ],
    });
    const failed = await seedRun(prisma, failedBot.id, "failed", "fail this run");
    await markUnread(prisma, failed.threadId);

    const routineThread = await prisma.thread.findUniqueOrThrow({
      where: { botId: routineBot.id },
    });
    await prisma.routine.create({
      data: {
        spaceId: routineThread.spaceId,
        botId: routineBot.id,
        userId: routineThread.userId,
        threadId: routineThread.id,
        name: "Morning brief",
        prompt: "Send the brief",
        crons: ["30 7 * * *"],
        timezone: "UTC",
        active: true,
        notify: true,
        nextRunAt: new Date(Date.now() - 60 * 60_000),
      },
    });

    // Another member's waiting run never appears in this person's inbox.
    const otherEmail = `attention-other-${stamp}@rakazo.test`;
    await signup(app, otherEmail, "Other User");
    const otherUser = await prisma.user.findUniqueOrThrow({ where: { email: otherEmail } });
    const otherThread = await prisma.thread.findUniqueOrThrow({
      where: { botId: otherMemberBot.id },
    });
    const otherRun = await seedRunForUser(prisma, otherMemberBot.id, "waiting_input", otherUser.id);
    await createThreadMessage(prisma, {
      threadId: otherThread.id,
      role: "bot",
      botId: otherMemberBot.id,
      runId: otherRun.id,
      blocks: [{ kind: "ask", text: "Not yours", status: "pending" }],
    });

    const result = await rpc<AttentionListOutput>(app, cookie, "attention/list");

    expect(
      result.items
        .map((item) => [item.kind, item.botName, item.detail])
        .sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? "")),
    ).toEqual([
      ["approval", "Approval Bot", "Read https://docs.example.test/page?q=fixture?"],
      ["failed", "Failed Bot", "fail this run"],
      ["question", "Question Bot", "Which city should I use?"],
      ["routine_delayed", "Routine Bot", "Morning brief"],
      ["secret", "Secret Bot", "i need that value in a protected field."],
      ["takeover", "Takeover Bot", ""],
    ]);

    const questionItem = result.items.find((item) => item.kind === "question")!;
    expect(questionItem.messageId).toBe(questionMessage.id);
    expect(questionItem.actions.map((action) => action.label)).toEqual(["Berlin", "Seoul"]);

    const approvalItem = result.items.find((item) => item.kind === "approval")!;
    expect(approvalItem.messageId).toBe(approvalMessage.id);
    expect(approvalItem.actions.map((action) => action.answer)).toEqual([
      "allow",
      "always",
      "deny",
    ]);
    const secretItem = result.items.find((item) => item.kind === "secret")!;
    expect(secretItem.messageId).toBe(secretMessage.id);
    expect(secretItem.actions).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("Other Member Bot");
    expect(JSON.stringify(result)).not.toContain("Not yours");
    expect(takeover.id).toBeTruthy();
  });

  it("includes a background run that waits on a person", async () => {
    const cookie = await signup(app, `attention-ticket-${stamp}@rakazo.test`, "Ticket User");
    const bot = await createBot(app, cookie, "Ticket Bot");
    const run = await seedRun(prisma, bot.id, "waiting_input", "work the ticket", "tickets");
    await createThreadMessage(prisma, {
      threadId: run.threadId,
      role: "bot",
      botId: bot.id,
      runId: run.id,
      blocks: [
        {
          kind: "ask",
          text: "Which ticket should I take?",
          status: "pending",
          actions: [{ id: "one", label: "One" }],
        },
      ],
    });

    const result = await rpc<AttentionListOutput>(app, cookie, "attention/list");

    expect(result.items.map((item) => [item.kind, item.botName])).toContainEqual([
      "question",
      "Ticket Bot",
    ]);
  });

  it("drops a failure that a later run superseded", async () => {
    const cookie = await signup(app, `attention-retry-${stamp}@rakazo.test`, "Retry User");
    const bot = await createBot(app, cookie, "Retry Bot");
    const failed = await seedRun(prisma, bot.id, "failed", "fail this run");
    await markUnread(prisma, failed.threadId);
    await seedRun(prisma, bot.id, "completed", "try again");

    const result = await rpc<AttentionListOutput>(app, cookie, "attention/list");

    expect(result.items.some((item) => item.kind === "failed")).toBe(false);
  });

  it("opens a delayed routine in the group it targets", async () => {
    const cookie = await signup(app, `attention-group-${stamp}@rakazo.test`, "Group User");
    const bot = await createBot(app, cookie, "Group Bot");
    const thread = await prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const group = await prisma.chatGroup.create({
      data: { spaceId: thread.spaceId, userId: thread.userId, name: "Crew" },
    });
    await prisma.chatGroupMember.create({ data: { groupId: group.id, botId: bot.id } });
    const groupThread = await prisma.thread.create({
      data: { spaceId: thread.spaceId, userId: thread.userId, groupId: group.id },
    });
    await prisma.routine.create({
      data: {
        spaceId: thread.spaceId,
        botId: bot.id,
        userId: thread.userId,
        threadId: groupThread.id,
        name: "Group brief",
        prompt: "Send the brief",
        crons: ["30 7 * * *"],
        timezone: "UTC",
        active: true,
        notify: true,
        nextRunAt: new Date(Date.now() - 60 * 60_000),
      },
    });

    const result = await rpc<AttentionListOutput>(app, cookie, "attention/list");
    const routine = result.items.find((item) => item.kind === "routine_delayed");

    expect(routine?.groupId).toBe(group.id);
    expect(routine?.groupName).toBe("Crew");
    expect(routine?.threadId).toBe(groupThread.id);
  });

  it("hides failed work from an archived group", async () => {
    const cookie = await signup(app, `attention-archive-${stamp}@rakazo.test`, "Archive User");
    const bot = await createBot(app, cookie, "Archived Group Bot");
    const botThread = await prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const group = await prisma.chatGroup.create({
      data: { spaceId: botThread.spaceId, userId: botThread.userId, name: "Old Crew" },
    });
    await prisma.chatGroupMember.create({ data: { groupId: group.id, botId: bot.id } });
    const groupThread = await prisma.thread.create({
      data: { spaceId: botThread.spaceId, userId: botThread.userId, groupId: group.id },
    });
    const task = await prisma.task.create({
      data: {
        spaceId: botThread.spaceId,
        userId: botThread.userId,
        botId: bot.id,
        threadId: groupThread.id,
        prompt: "fail in the group",
        status: "failed",
      },
    });
    await prisma.run.create({
      data: {
        spaceId: botThread.spaceId,
        userId: botThread.userId,
        botId: bot.id,
        threadId: groupThread.id,
        taskId: task.id,
        status: "failed",
        trigger: "user",
        completedAt: new Date(),
      },
    });
    await markUnread(prisma, groupThread.id);
    await prisma.chatGroup.update({
      where: { id: group.id },
      data: { archivedAt: new Date() },
    });

    const result = await rpc<AttentionListOutput>(app, cookie, "attention/list");

    expect(result.items.some((item) => item.kind === "failed")).toBe(false);
  });
});

async function createBot(app: App, cookie: string, name: string) {
  return rpc<{ id: string; threadId: string }>(app, cookie, "bots/create", {
    name,
    title: name,
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
}

async function markUnread(prisma: PrismaClient, threadId: string) {
  const thread = await prisma.thread.findUniqueOrThrow({
    where: { id: threadId },
    select: { spaceId: true, userId: true },
  });
  await prisma.threadRead.create({
    data: { threadId, spaceId: thread.spaceId, userId: thread.userId, unread: true },
  });
}

async function seedRun(
  prisma: PrismaClient,
  botId: string,
  status: "waiting_input" | "waiting_takeover" | "failed" | "completed",
  prompt: string,
  trigger = "user",
) {
  const thread = await prisma.thread.findUniqueOrThrow({ where: { botId } });
  const task = await prisma.task.create({
    data: {
      spaceId: thread.spaceId,
      userId: thread.userId,
      botId,
      threadId: thread.id,
      prompt,
      status,
    },
  });
  const terminal = status === "failed" || status === "completed";
  return prisma.run.create({
    data: {
      spaceId: thread.spaceId,
      userId: thread.userId,
      botId,
      threadId: thread.id,
      taskId: task.id,
      status,
      trigger,
      completedAt: terminal ? new Date() : null,
    },
  });
}

async function seedRunForUser(
  prisma: PrismaClient,
  botId: string,
  status: "waiting_input",
  userId: string,
) {
  const thread = await prisma.thread.findUniqueOrThrow({ where: { botId } });
  const task = await prisma.task.create({
    data: { spaceId: thread.spaceId, userId, botId, threadId: thread.id, prompt: "other", status },
  });
  return prisma.run.create({
    data: {
      spaceId: thread.spaceId,
      userId,
      botId,
      threadId: thread.id,
      taskId: task.id,
      status,
      trigger: "user",
    },
  });
}

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "test-password-123", name }),
  });
  expect(response.status).toBeLessThan(400);
  return sessionCookieHeader(response);
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}
