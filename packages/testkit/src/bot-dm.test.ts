import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { messageBot } from "@rakazo/adapters";
import { CHAT_GROUP_KIND_BOT_DM } from "@rakazo/contracts";
import { createThreadEvents } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;

describeIntegration("bot-to-bot direct messages", () => {
  let handles: Awaited<ReturnType<typeof import("../../../apps/api/src/app.ts")["createApp"]>>;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-bot-dm-"));
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      defaultProvider: "scripted",
      defaultModel: "scripted",
    });
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function signup(email: string, name: string) {
    const res = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
      },
      body: JSON.stringify({ email, password: "password12", name }),
    });
    if (res.status >= 400) throw new Error(`signup failed ${res.status}: ${await res.text()}`);
    const cookies = res.headers.getSetCookie?.() ?? [];
    return cookies.map((value) => value.split(";")[0]).join("; ");
  }

  async function rpc<T>(cookie: string, proc: string, body: unknown = {}): Promise<T> {
    const res = await handles.app.request(`/rpc/${proc}`, {
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

  async function createBot(cookie: string, name: string) {
    return rpc<{ id: string; workspaceId: string; threadId: string }>(cookie, "bots/create", {
      name,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
  }

  async function seedRunningRun(input: {
    workspaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    prompt?: string;
  }) {
    const task = await handles.prisma.task.create({
      data: {
        workspaceId: input.workspaceId,
        botId: input.botId,
        threadId: input.threadId,
        userId: input.userId,
        prompt: input.prompt ?? "work",
        status: "running",
      },
    });
    return handles.prisma.run.create({
      data: {
        workspaceId: input.workspaceId,
        botId: input.botId,
        threadId: input.threadId,
        taskId: task.id,
        userId: input.userId,
        status: "running",
        trigger: "user",
      },
    });
  }

  it("creates a bot DM thread and enqueues the target bot", async () => {
    const cookie = await signup(`bot-dm-${stamp}@rakazo.test`, "Bot DM Owner");
    const botA = await createBot(cookie, "Writer");
    const botB = await createBot(cookie, "Researcher");
    const run = await seedRunningRun({
      workspaceId: botA.workspaceId,
      userId: (await rpc<{ userId: string }>(cookie, "me")).userId,
      botId: botA.id,
      threadId: botA.threadId,
    });

    const beforeGroups = await rpc<Array<{ id: string; kind: string }>>(cookie, "groups/list");
    expect(beforeGroups.some((group) => group.kind === CHAT_GROUP_KIND_BOT_DM)).toBe(false);

    const result = await messageBot(
      { prisma: handles.prisma, events: createThreadEvents(handles.prisma), jobs: handles.jobs },
      {
        id: run.id,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        botId: run.botId,
        userId: run.userId,
      },
      { confirm_name: "Researcher", message: "Find three sources on the topic." },
    );
    expect(result).toMatchObject({ ok: true, botId: botB.id });

    const groups = await rpc<
      Array<{ id: string; kind: string; members: Array<{ botId: string }> }>
    >(cookie, "groups/list");
    const dmGroup = groups.find((group) => group.id === result.groupId);
    expect(dmGroup).toMatchObject({ kind: CHAT_GROUP_KIND_BOT_DM });
    expect(dmGroup?.members.map((member) => member.botId).sort()).toEqual(
      [botA.id, botB.id].sort(),
    );

    const dmSnap = await rpc<{
      messages: Array<{ blocks: Array<{ kind?: string; text?: string }> }>;
    }>(cookie, "threads/get", { groupId: result.groupId });
    expect(
      dmSnap.messages.some((message) =>
        message.blocks.some((block) => block.kind === "handoff" && block.text?.includes("sources")),
      ),
    ).toBe(true);

    const targetRun = await handles.prisma.run.findUniqueOrThrow({ where: { id: result.runId } });
    expect(targetRun.botId).toBe(botB.id);
    expect(targetRun.threadId).toBe(result.threadId);
    expect(["queued", "running", "completed"]).toContain(targetRun.status);
  });

  it("reuses the same DM thread for a second message", async () => {
    const cookie = await signup(`bot-dm-reuse-${stamp}@rakazo.test`, "Reuse Owner");
    const botA = await createBot(cookie, "Planner");
    const botB = await createBot(cookie, "Executor");
    const me = await rpc<{ userId: string }>(cookie, "me");
    const run = await seedRunningRun({
      workspaceId: botA.workspaceId,
      userId: me.userId,
      botId: botA.id,
      threadId: botA.threadId,
    });
    const deps = {
      prisma: handles.prisma,
      events: createThreadEvents(handles.prisma),
      jobs: handles.jobs,
    };
    const first = await messageBot(
      deps,
      {
        id: run.id,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        botId: run.botId,
        userId: run.userId,
      },
      { bot_id: botB.id, message: "First ask" },
    );
    expect(first.ok).toBe(true);

    const runAgain = await seedRunningRun({
      workspaceId: botA.workspaceId,
      userId: me.userId,
      botId: botA.id,
      threadId: botA.threadId,
    });
    const second = await messageBot(
      deps,
      {
        id: runAgain.id,
        workspaceId: runAgain.workspaceId,
        threadId: runAgain.threadId,
        botId: runAgain.botId,
        userId: runAgain.userId,
      },
      { bot_id: botB.id, message: "Second ask" },
    );
    expect(second.groupId).toBe(first.groupId);
    expect(
      await handles.prisma.chatGroup.count({
        where: { kind: CHAT_GROUP_KIND_BOT_DM, userId: me.userId },
      }),
    ).toBe(1);
  });

  it("rejects self-messages and foreign workspace bots", async () => {
    const owner = await signup(`bot-dm-owner-${stamp}@rakazo.test`, "Owner");
    const intruder = await signup(`bot-dm-intruder-${stamp}@rakazo.test`, "Intruder");
    const botA = await createBot(owner, "Alpha");
    const botB = await createBot(owner, "Beta");
    const foreign = await createBot(intruder, "Foreign");
    const me = await rpc<{ userId: string }>(owner, "me");
    const run = await seedRunningRun({
      workspaceId: botA.workspaceId,
      userId: me.userId,
      botId: botA.id,
      threadId: botA.threadId,
    });
    const deps = {
      prisma: handles.prisma,
      events: createThreadEvents(handles.prisma),
      jobs: handles.jobs,
    };

    expect(
      await messageBot(
        deps,
        {
          id: run.id,
          workspaceId: run.workspaceId,
          threadId: run.threadId,
          botId: run.botId,
          userId: run.userId,
        },
        { bot_id: botA.id, message: "nope" },
      ),
    ).toEqual({ error: "cannot message yourself" });

    expect(
      await messageBot(
        deps,
        {
          id: run.id,
          workspaceId: run.workspaceId,
          threadId: run.threadId,
          botId: run.botId,
          userId: run.userId,
        },
        { bot_id: foreign.id, message: "nope" },
      ),
    ).toEqual({ error: "target bot is not in this workspace" });

    expect(botB.id).not.toBe(foreign.id);
  });
});
