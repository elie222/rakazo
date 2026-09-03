import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ComposioEmulator,
  createScheduleFromTool,
  DesktopSandboxProvider,
  FakeSandboxProvider,
  handoffToGroupBot,
  ManagedSandboxEmulator,
} from "@rakazo/adapters";
import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import {
  appendEvent,
  createThreadEvents,
  createThreadMessage,
  RunHistoryWriteError,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeJourneys = hasDb ? describe : describe.skip;

describeJourneys("required product journeys", () => {
  let app: App;
  let stop: () => Promise<void>;
  let prisma: Awaited<
    ReturnType<typeof import("../../../apps/api/src/app.ts").createApp>
  >["prisma"];
  let connector: Awaited<
    ReturnType<typeof import("../../../apps/api/src/app.ts").createApp>
  >["connector"];
  let executor: Awaited<
    ReturnType<typeof import("../../../apps/api/src/app.ts").createApp>
  >["executor"];
  let jobs: Awaited<ReturnType<typeof import("../../../apps/api/src/app.ts").createApp>>["jobs"];
  let sandbox: Awaited<
    ReturnType<typeof import("../../../apps/api/src/app.ts").createApp>
  >["sandbox"];
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-journey-"));

  async function sendAndWait(app: App, cookie: string, botId: string, text: string) {
    const { runId } = await rpc<{ runId: string }>(app, cookie, "threads/send", { botId, text });
    let terminal: { status: string; error: string | null } | null = null;
    await waitForDatabase(async () => {
      terminal = await prisma.run.findUnique({
        where: { id: runId },
        select: { status: true, error: true },
      });
      return Boolean(terminal && ["completed", "failed", "cancelled"].includes(terminal.status));
    });
    if (!terminal) throw new Error(`run ${runId} was not found after completion`);
    if (terminal.status !== "completed") {
      throw new Error(
        `run ${runId} ended ${terminal.status}: ${terminal.error ?? "unknown error"}`,
      );
    }
    return {
      ...(await rpc<Snap>(app, cookie, "threads/get", { botId })),
      run: { id: runId, status: terminal.status },
    };
  }

  async function sendGroupAndWait(
    app: App,
    cookie: string,
    groupId: string,
    text: string,
    waitForBotId?: string,
  ) {
    const { runIds, runId } = await rpc<{ runId: string; runIds?: string[] }>(
      app,
      cookie,
      "threads/send",
      {
        groupId,
        text,
      },
    );
    let targets = runIds ?? [runId];
    if (waitForBotId) {
      const runs = await prisma.run.findMany({
        where: { id: { in: targets }, botId: waitForBotId },
        select: { id: true },
      });
      targets = runs.map((run) => run.id);
      if (targets.length === 0) {
        throw new Error(`no run scheduled for bot ${waitForBotId}`);
      }
    }
    for (const runId of targets) {
      let terminal: { status: string; error: string | null } | null = null;
      await waitForDatabase(async () => {
        terminal = await prisma.run.findUnique({
          where: { id: runId },
          select: { status: true, error: true },
        });
        return Boolean(terminal && ["completed", "failed", "cancelled"].includes(terminal.status));
      });
      if (!terminal) throw new Error(`run ${runId} was not found after completion`);
      if (terminal.status !== "completed") {
        throw new Error(
          `run ${runId} ended ${terminal.status}: ${terminal.error ?? "unknown error"}`,
        );
      }
    }
    return rpc<Snap>(app, cookie, "threads/get", { groupId });
  }

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      composio: new ComposioEmulator(),
    });
    app = handles.app;
    stop = handles.stop;
    prisma = handles.prisma;
    connector = handles.connector;
    executor = handles.executor;
    jobs = handles.jobs;
    sandbox = handles.sandbox;
  });

  afterAll(async () => {
    await stop?.();
  });

  it("1+2: users are isolated and workspace bots share the Team Computer", async () => {
    const ada = await signup(app, `ada-j-${stamp}@rakazo.test`, "Ada Journey");
    const bob = await signup(app, `bob-j-${stamp}@rakazo.test`, "Bob Journey");

    const adaMe = await rpc<Me>(app, ada, "me");
    const bobMe = await rpc<Me>(app, bob, "me");
    expect(adaMe.spaceId).not.toBe(bobMe.spaceId);

    const chief = await rpc<Bot>(app, ada, "bots/create", {
      name: "Chief",
      title: "Chief of staff",
      description: "Keeps work moving",
      instructions: "",
      notifyOnFinish: true,
    });
    const coder = await rpc<Bot>(app, ada, "bots/create", {
      name: "Coder",
      title: "Engineer",
      description: "Writes code",
      instructions: "",
      notifyOnFinish: true,
    });
    const bobBot = await rpc<Bot>(app, bob, "bots/create", {
      name: "Chief",
      title: "Chief of staff",
      description: "Bob's bot",
      instructions: "",
      notifyOnFinish: true,
    });
    const [chiefRecord, coderRecord, bobRecord] = await Promise.all(
      [chief.id, coder.id, bobBot.id].map((id) =>
        prisma.bot.findUniqueOrThrow({ where: { id }, include: { computer: true } }),
      ),
    );
    expect(chief.computerMode).toBe("team");
    expect(coder.computerMode).toBe("team");
    expect(chiefRecord.computerId).toBe(coderRecord.computerId);
    expect(chiefRecord.computerId).not.toBe(bobRecord.computerId);

    const bobList = await rpc<Bot[]>(app, bob, "bots/list");
    expect(bobList.map((b) => b.id)).not.toContain(chief.id);
    const forbidden = await raw(app, bob, "bots/get", { botId: chief.id });
    expect(forbidden.status).toBeGreaterThanOrEqual(400);

    const pinned = await rpc<Bot>(app, ada, "bots/update", { botId: coder.id, pinned: true });
    expect(pinned.pinned).toBe(true);
    const [section, concurrentSection] = await Promise.all([
      rpc<{ id: string; name: string }>(app, ada, "botSections/create", {
        botId: chief.id,
        name: "Planning",
      }),
      rpc<{ id: string; name: string }>(app, ada, "botSections/create", {
        botId: coder.id,
        name: "Planning",
      }),
    ]);
    expect(section.name).toBe("Planning");
    expect(concurrentSection.id).toBe(section.id);
    expect(await rpc<Array<{ id: string }>>(app, ada, "botSections/list")).toEqual([
      expect.objectContaining({ id: section.id }),
    ]);
    expect(
      (await rpc<Bot[]>(app, ada, "bots/list")).find((bot) => bot.id === chief.id)?.sectionId,
    ).toBe(section.id);
    expect(
      (await rpc<Bot[]>(app, ada, "bots/list")).find((bot) => bot.id === coder.id)?.sectionId,
    ).toBe(section.id);
    const foreignSection = await raw(app, bob, "bots/update", {
      botId: bobBot.id,
      sectionId: section.id,
    });
    expect(foreignSection.status).toBeGreaterThanOrEqual(400);
    expect(await rpc<unknown[]>(app, bob, "botSections/list")).toEqual([]);
    const duplicate = await rpc<Bot>(app, ada, "bots/duplicate", { botId: chief.id });
    expect(duplicate).toMatchObject({
      name: "Chief copy",
      title: chief.title,
      description: chief.description,
      instructions: chief.instructions,
      notifyOnFinish: chief.notifyOnFinish,
      color: chief.color,
      pinned: false,
      sectionId: null,
      unread: false,
    });
    expect(duplicate.id).not.toBe(chief.id);
    expect((await rpc<Bot[]>(app, ada, "bots/list"))[0]?.id).toBe(coder.id);

    await sendAndWait(
      app,
      ada,
      chief.id,
      "write a file in your home called notes/result.txt that says isolation-ok",
    );
    expect(
      (await rpc<Bot[]>(app, ada, "bots/list")).find((bot) => bot.id === chief.id)?.unread,
    ).toBe(true);
    await rpc(app, ada, "threads/markRead", { botId: chief.id });
    expect(
      (await rpc<Bot[]>(app, ada, "bots/list")).find((bot) => bot.id === chief.id)?.unread,
    ).toBe(false);
    await rpc(app, ada, "threads/markUnread", { botId: chief.id });
    expect(
      (await rpc<Bot[]>(app, ada, "bots/list")).find((bot) => bot.id === chief.id)?.unread,
    ).toBe(true);
    await sendAndWait(app, ada, coder.id, "remember that coder prefers rust");

    const chiefFile = await rpc<{ path: string; content: string }>(app, ada, "computer/readFile", {
      botId: chief.id,
      path: "notes/result.txt",
    });
    expect(chiefFile.content).toContain("isolation-ok");
    const computer = await rpc<{ state: string }>(app, ada, "computer/status", { botId: chief.id });
    expect(computer.state).toBe("running");
    await rpc(app, ada, "computer/stop", { botId: chief.id });
    const persisted = await rpc<{ content: string }>(app, ada, "computer/readFile", {
      botId: chief.id,
      path: "notes/result.txt",
    });
    expect(persisted.content).toContain("isolation-ok");
    const coderMem = await rpc<Array<{ content: string }>>(app, ada, "memory/list", {
      botId: coder.id,
    });
    expect(coderMem.some((m) => m.content.toLowerCase().includes("rust"))).toBe(true);
    const dedicated = await rpc<Bot>(app, ada, "bots/setComputer", {
      botId: coder.id,
      mode: "dedicated",
    });
    expect(dedicated.computerMode).toBe("dedicated");
    const dedicatedRecord = await prisma.bot.findUniqueOrThrow({
      where: { id: coder.id },
      include: { computer: true },
    });
    expect(dedicatedRecord.computerId).not.toBe(chiefRecord.computerId);
    await rpc<Bot>(app, ada, "bots/setComputer", { botId: coder.id, mode: "team" });
    const backOnTeam = await prisma.bot.findUniqueOrThrow({ where: { id: coder.id } });
    expect(backOnTeam.computerId).toBe(chiefRecord.computerId);
    await rpc<Bot>(app, ada, "bots/setComputer", { botId: coder.id, mode: "dedicated" });
    const reusedDedicated = await prisma.bot.findUniqueOrThrow({ where: { id: coder.id } });
    expect(reusedDedicated.computerId).toBe(dedicatedRecord.computerId);
    expect(bobBot.id).not.toBe(chief.id);
  });

  it("clears a conversation without removing the bot, computer, memory, or routines", async () => {
    const cookie = await signup(app, `clear-j-${stamp}@rakazo.test`, "Clear Journey");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Keeper",
      title: "Keeps its setup",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await sendAndWait(
      app,
      cookie,
      bot.id,
      "write a file in your home called notes/result.txt that says kept-after-clear",
    );
    const memories = await rpc<Array<{ id: string }>>(app, cookie, "memory/list", {
      botId: bot.id,
    });
    await rpc(app, cookie, "memory/update", {
      documentId: memories[0]!.id,
      content: "# Keeper\n\nRemember this after clearing.",
    });
    const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
      botId: bot.id,
      name: "Kept routine",
      prompt: "Check in",
      crons: ["0 9 * * 1"],
      timezone: "UTC",
      notify: false,
      active: false,
    });
    const thread = await prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId: thread.spaceId,
        userId: thread.userId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "queued before clear",
        status: "queued",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: thread.spaceId,
        userId: thread.userId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "queued",
        trigger: "user",
      },
    });
    await prisma.thread.update({
      where: { id: thread.id },
      data: {
        historyCompactedUpToSeq: 0,
        historyCompactionSummary: "summary that must be invalidated",
        historyCompactionGeneration: 3,
      },
    });

    await rpc(app, cookie, "threads/clear", { botId: bot.id });

    const snap = await rpc<Snap>(app, cookie, "threads/get", { botId: bot.id });
    expect(snap.messages).toEqual([]);
    expect(snap.run).toBeNull();
    expect(await prisma.message.count({ where: { threadId: thread.id } })).toBe(0);
    expect(await prisma.event.findMany({ where: { threadId: thread.id } })).toMatchObject([
      { type: "thread.cleared" },
    ]);
    // The deleted messages all count as compacted, so compaction cannot summarize them and
    // recall cannot treat the fresh conversation as having uncompacted history.
    const clearedThread = await prisma.thread.findUniqueOrThrow({ where: { id: thread.id } });
    expect(clearedThread.historyCompactedUpToSeq).toBe(clearedThread.nextMessageSeq - 1);
    expect(clearedThread.historyCompactionSummary).toBeNull();
    expect(clearedThread.historyCompactionGeneration).toBe(4);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      (await rpc<Bot[]>(app, cookie, "bots/list")).find((item) => item.id === bot.id),
    ).toMatchObject({
      preview: "",
      unread: false,
    });
    expect(
      await rpc(app, cookie, "computer/readFile", { botId: bot.id, path: "notes/result.txt" }),
    ).toMatchObject({ content: expect.stringContaining("kept-after-clear") });
    expect(await rpc(app, cookie, "memory/list", { botId: bot.id })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining("Remember this") }),
      ]),
    );
    expect(await rpc(app, cookie, "routines/list", { botId: bot.id })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: routine.id })]),
    );

    await expect(
      appendEvent(prisma, {
        spaceId: thread.spaceId,
        threadId: thread.id,
        botId: bot.id,
        type: "thread.progress",
        runId: run.id,
        payload: { text: "stale output after clear" },
      }),
    ).rejects.toThrow(RunHistoryWriteError);
    await expect(
      createThreadMessage(prisma, {
        threadId: thread.id,
        role: "bot",
        blocks: [{ kind: "text", text: "stale output after clear" }],
        runId: run.id,
      }),
    ).rejects.toThrow(RunHistoryWriteError);
    expect(await prisma.message.count({ where: { threadId: thread.id } })).toBe(0);
    expect(await prisma.event.findMany({ where: { threadId: thread.id } })).toMatchObject([
      { type: "thread.cleared" },
    ]);

    const after = await sendAndWait(
      app,
      cookie,
      bot.id,
      "write a file in your home called notes/after-clear.txt that says hello-after-clear",
    );
    expect(after.messages.length).toBeGreaterThan(0);
    expect(await prisma.message.count({ where: { threadId: thread.id } })).toBeGreaterThan(0);
  });

  it("2b: two Team bots send at once on distinct screens", async () => {
    const cookie = await signup(app, `parallel-j-${stamp}@rakazo.test`, "Parallel");
    const writer = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Writer",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const researcher = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Researcher",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const [writerSnap, researcherSnap] = await Promise.all([
      sendAndWait(app, cookie, writer.id, "observe your screen and type writer-desk"),
      sendAndWait(app, cookie, researcher.id, "observe your screen and type researcher-desk"),
    ]);
    expect(writerSnap.run?.status).toBe("completed");
    expect(researcherSnap.run?.status).toBe("completed");
    expect(
      (
        await rpc<{ busyBotName: string | null }>(app, cookie, "computer/status", {
          botId: writer.id,
        })
      ).busyBotName,
    ).toBeNull();
    expect(
      (
        await rpc<{ busyBotName: string | null }>(app, cookie, "computer/status", {
          botId: researcher.id,
        })
      ).busyBotName,
    ).toBeNull();
    const writerScreen = await rpc<{ url: string | null }>(app, cookie, "computer/screenUrl", {
      botId: writer.id,
    });
    const researcherScreen = await rpc<{ url: string | null }>(app, cookie, "computer/screenUrl", {
      botId: researcher.id,
    });
    expect(writerScreen.url).toContain(writer.id);
    expect(researcherScreen.url).toContain(researcher.id);
    expect(writerScreen.url).not.toBe(researcherScreen.url);
  });

  it("3: disconnect and reconnect from a cursor reconstructs the thread", async () => {
    const cookie = await signup(app, `cursor-j-${stamp}@rakazo.test`, "Cursor");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await sendAndWait(
      app,
      cookie,
      bot.id,
      "write a file in your home called notes/result.txt that says reconnect-ok",
    );
    const snap = await rpc<Snap>(app, cookie, "threads/get", { botId: bot.id });
    expect(snap.messages.map((m) => m.seq)).toEqual(
      [...snap.messages].map((m) => m.seq).sort((a, b) => a - b),
    );
    expect(snap.messages.some((m) => JSON.stringify(m.blocks).includes("reconnect-ok"))).toBe(true);
    const again = await rpc<Snap>(app, cookie, "threads/get", { botId: bot.id });
    expect(again.messages.length).toBe(snap.messages.length);
  });

  it("4: takeover login then resume without exposing credentials", async () => {
    const cookie = await signup(app, `takeover-j-${stamp}@rakazo.test`, "Takeover");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await rpc(app, cookie, "threads/send", {
      botId: bot.id,
      text: "install the gsc cli and sign in",
    });
    const waiting = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.status === "waiting_takeover",
    );
    expect(JSON.stringify(waiting.messages)).not.toMatch(/password|secret|token/i);
    await rpc(app, cookie, "computer/boot", { botId: bot.id });
    await rpc(app, cookie, "computer/takeover", { botId: bot.id });
    await rpc(app, cookie, "computer/release", { botId: bot.id });
    const done = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(JSON.stringify(done.messages).toLowerCase()).toMatch(/signed in|session/);
    expect(done.run?.status ?? "completed").not.toBe("waiting_takeover");

    const releaseEvents = await prisma.event.count({
      where: { botId: bot.id, type: "computer.takeover.released" },
    });
    await rpc(app, cookie, "computer/release", { botId: bot.id });
    expect(
      await prisma.event.count({
        where: { botId: bot.id, type: "computer.takeover.released" },
      }),
    ).toBe(releaseEvents);
  });

  it("4d: skipping takeover resumes without treating login as done", async () => {
    const cookie = await signup(app, `takeover-skip-j-${stamp}@rakazo.test`, "Skip Takeover");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await rpc(app, cookie, "threads/send", {
      botId: bot.id,
      text: "install the gsc cli and sign in",
    });
    const waiting = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.status === "waiting_takeover",
    );
    await rpc(app, cookie, "computer/boot", { botId: bot.id });
    await rpc(app, cookie, "computer/takeover", { botId: bot.id });
    await rpc(app, cookie, "computer/release", { botId: bot.id, reason: "skipped" });
    const done = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(JSON.stringify(done.messages).toLowerCase()).toMatch(/skipped/);
    expect(JSON.stringify(done.messages).toLowerCase()).not.toMatch(/signed in/);
    expect(done.run?.status ?? "completed").not.toBe("waiting_takeover");
    const released = await prisma.event.findFirst({
      where: { botId: bot.id, type: "computer.takeover.released" },
      orderBy: { createdAt: "desc" },
    });
    expect(released).toMatchObject({
      runId: waiting.run?.id,
      payload: { reason: "skipped" },
    });
  });

  it("4b: an expired takeover denies input and reconciles API and database state", async () => {
    const previousTakeoverTtl = process.env.COMPUTER_TAKEOVER_TTL_MS;
    process.env.COMPUTER_TAKEOVER_TTL_MS = "1000";
    try {
      const cookie = await signup(app, `takeover-expiry-j-${stamp}@rakazo.test`, "Expiry");
      const bot = await rpc<Bot>(app, cookie, "bots/create", {
        name: "Chief",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: true,
      });
      await rpc(app, cookie, "threads/send", {
        botId: bot.id,
        text: "install the gsc cli and sign in",
      });
      const waiting = await waitFor(
        app,
        cookie,
        bot.id,
        (snap) => snap.run?.status === "waiting_takeover",
      );
      await rpc(app, cookie, "computer/boot", { botId: bot.id });
      const lease = await rpc<{ leaseId: string; expiresAt: string }>(
        app,
        cookie,
        "computer/takeover",
        { botId: bot.id },
      );
      expect(new Date(lease.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(1000);
      expect(
        (await rpc<{ url: string | null }>(app, cookie, "computer/screenUrl", { botId: bot.id }))
          .url,
      ).toContain("view_only=false");
      await rpc(app, cookie, "computer/input", {
        botId: bot.id,
        kind: "key",
        payload: { key: "a" },
      });

      await waitForDatabase(async () => {
        const storedBot = await prisma.bot.findUniqueOrThrow({
          where: { id: bot.id },
          include: { computer: true },
        });
        const computer = storedBot.computer!;
        return computer.controlLeaseId === null && computer.controlHolder === "none";
      });

      expect(
        (await rpc<{ controlHolder: string }>(app, cookie, "computer/status", { botId: bot.id }))
          .controlHolder,
      ).toBe("none");
      expect(
        (await rpc<{ url: string | null }>(app, cookie, "computer/screenUrl", { botId: bot.id }))
          .url,
      ).toContain("view_only=true");
      expect(
        (
          await raw(app, cookie, "computer/input", {
            botId: bot.id,
            kind: "key",
            payload: { key: "b" },
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
      const done = await waitFor(
        app,
        cookie,
        bot.id,
        (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
      );
      expect(JSON.stringify(done.messages).toLowerCase()).toMatch(/skipped/);
      expect(JSON.stringify(done.messages).toLowerCase()).not.toMatch(/signed in/);
      expect(done.run?.status ?? "completed").not.toBe("waiting_takeover");
      expect(
        await prisma.event.findFirst({
          where: { runId: waiting.run?.id, type: "computer.takeover.released" },
          orderBy: { createdAt: "desc" },
        }),
      ).toMatchObject({ payload: { reason: "expired" } });
    } finally {
      if (previousTakeoverTtl === undefined) delete process.env.COMPUTER_TAKEOVER_TTL_MS;
      else process.env.COMPUTER_TAKEOVER_TTL_MS = previousTakeoverTtl;
    }
  });

  it("4c: a takeover authorizes input only on the controlled bot screen", async () => {
    const cookie = await signup(app, `takeover-scope-j-${stamp}@rakazo.test`, "Takeover Scope");
    const writer = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Writer",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const researcher = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Researcher",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });

    await rpc(app, cookie, "computer/boot", { botId: writer.id });
    await rpc(app, cookie, "computer/takeover", { botId: writer.id });
    expect(
      (
        await raw(app, cookie, "computer/input", {
          botId: researcher.id,
          kind: "key",
          payload: { key: "A" },
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    await rpc(app, cookie, "computer/release", { botId: writer.id });
  });

  it("4d: a stale Team release cannot clear a newer bot takeover", async () => {
    const cookie = await signup(
      app,
      `takeover-release-fence-j-${stamp}@rakazo.test`,
      "Release Fence",
    );
    const writer = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Writer",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const researcher = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Researcher",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });

    await rpc(app, cookie, "computer/boot", { botId: writer.id });
    await rpc(app, cookie, "threads/send", {
      botId: researcher.id,
      text: "install the gsc cli and sign in",
    });
    await waitFor(app, cookie, researcher.id, (snap) => snap.run?.status === "waiting_takeover");

    const writerLease = await rpc<{ leaseId: string; expiresAt: string }>(
      app,
      cookie,
      "computer/takeover",
      { botId: writer.id },
    );
    const releaseEventsBefore = await prisma.event.count({
      where: { botId: researcher.id, type: "computer.takeover.released" },
    });

    const originalSetScreenControl = sandbox.setScreenControl;
    let signalReleaseRevocation!: () => void;
    let allowReleaseRevocation!: () => void;
    const releaseRevocationReached = new Promise<void>((resolve) => {
      signalReleaseRevocation = resolve;
    });
    const releaseRevocationAllowed = new Promise<void>((resolve) => {
      allowReleaseRevocation = resolve;
    });
    const revokedLeases: string[] = [];
    sandbox.setScreenControl = async (_computer, interactive, context, controlToken) => {
      expect(interactive).toBe(false);
      revokedLeases.push(controlToken ?? "");
      if (revokedLeases.length !== 1) return;
      expect(context.botId).toBe(writer.id);
      expect(controlToken).toBe(writerLease.leaseId);
      signalReleaseRevocation();
      await releaseRevocationAllowed;
    };

    let staleRelease: Promise<{ ok: true }> | undefined;
    let researcherLease!: { leaseId: string; expiresAt: string };
    try {
      // Pause Release after it captures Writer's lease but before database finalization. The
      // replacement takeover then commits first, so the resumed Release must lose its lease CAS.
      staleRelease = rpc<{ ok: true }>(app, cookie, "computer/release", { botId: writer.id });
      await releaseRevocationReached;
      researcherLease = await rpc<{ leaseId: string; expiresAt: string }>(
        app,
        cookie,
        "computer/takeover",
        { botId: researcher.id },
      );
      allowReleaseRevocation();
      await staleRelease;
    } finally {
      allowReleaseRevocation();
      await staleRelease?.catch(() => undefined);
      sandbox.setScreenControl = originalSetScreenControl;
    }

    expect(researcherLease.leaseId).not.toBe(writerLease.leaseId);
    expect(revokedLeases).toEqual([writerLease.leaseId, writerLease.leaseId]);

    const writerRecord = await prisma.bot.findUniqueOrThrow({
      where: { id: writer.id },
      include: { computer: true },
    });
    const researcherRecord = await prisma.bot.findUniqueOrThrow({
      where: { id: researcher.id },
      include: { computer: true },
    });
    const computerId = writerRecord.computer!.id;
    expect(researcherRecord.computer!.id).toBe(computerId);
    const afterStaleRelease = await prisma.computer.findUniqueOrThrow({
      where: { id: computerId },
    });
    expect(afterStaleRelease.controlHolder).toBe("user");
    expect(afterStaleRelease.controlBotId).toBe(researcher.id);
    expect(afterStaleRelease.controlLeaseId).toBe(researcherLease.leaseId);
    expect(afterStaleRelease.controlLeaseExpiresAt?.toISOString()).toBe(researcherLease.expiresAt);
    expect(
      await prisma.event.count({
        where: { botId: researcher.id, type: "computer.takeover.released" },
      }),
    ).toBe(releaseEventsBefore);
    expect(
      (
        await prisma.run.findFirstOrThrow({
          where: { botId: researcher.id, status: "waiting_takeover" },
        })
      ).status,
    ).toBe("waiting_takeover");

    await rpc(app, cookie, "computer/release", { botId: researcher.id });
    const afterOwnerRelease = await prisma.computer.findUniqueOrThrow({
      where: { id: computerId },
    });
    expect(afterOwnerRelease).toMatchObject({
      controlHolder: "bot",
      controlBotId: null,
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
    });
    await waitFor(
      app,
      cookie,
      researcher.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(
      await prisma.event.count({
        where: { botId: researcher.id, type: "computer.takeover.released" },
      }),
    ).toBe(releaseEventsBefore + 1);
    const releaseEvent = await prisma.event.findFirstOrThrow({
      where: { botId: researcher.id, type: "computer.takeover.released" },
      orderBy: { seq: "desc" },
    });
    expect(releaseEvent.payload).toMatchObject({
      holder: "bot",
      leaseId: researcherLease.leaseId,
      reason: "released",
    });

    await rpc(app, cookie, "computer/release", { botId: researcher.id });
    expect(
      await prisma.event.count({
        where: { botId: researcher.id, type: "computer.takeover.released" },
      }),
    ).toBe(releaseEventsBefore + 1);
  });

  it("5: a routine wakes the bot and posts into the existing thread", async () => {
    const cookie = await signup(app, `routine-j-${stamp}@rakazo.test`, "Routine");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const routine = await rpc<{ id: string; nextRunAt: string | null }>(
      app,
      cookie,
      "routines/create",
      {
        botId: bot.id,
        name: "Monday briefing",
        prompt: "write a file in your home called notes/result.txt that says routine-ok",
        crons: ["0 9 * * 1"],
        timezone: "UTC",
        notify: true,
        active: true,
      },
    );
    expect(routine.nextRunAt).toBeTruthy();
    const dueAt = new Date(Date.now() - 1_000);
    await prisma.routine.update({
      where: { id: routine.id },
      data: { nextRunAt: dueAt },
    });
    await jobs.enqueue({
      name: "routine.wakeup",
      payload: { routineId: routine.id, scheduledFor: dueAt.toISOString() },
    });
    await jobs.enqueue({
      name: "routine.wakeup",
      payload: { routineId: routine.id, scheduledFor: dueAt.toISOString() },
    });
    const snap = await waitFor(app, cookie, bot.id, (s) =>
      s.messages.some(
        (m) =>
          JSON.stringify(m.blocks).includes("routine-ok") ||
          JSON.stringify(m.blocks).includes("writing"),
      ),
    );
    expect(snap.messages.length).toBeGreaterThan(0);
    const routineRuns = await prisma.run.count({
      where: { botId: bot.id, trigger: "routine" },
    });
    expect(routineRuns).toBe(1);
    const advanced = await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(advanced.nextRunAt?.getTime()).toBeGreaterThan(dueAt.getTime());

    const legacyRunsBefore = await prisma.run.count({
      where: { botId: bot.id, trigger: "routine" },
    });
    const legacyDueAt = new Date(Date.now() - 1_000);
    const legacy = await prisma.routine.create({
      data: {
        spaceId: advanced.spaceId,
        userId: advanced.userId,
        botId: bot.id,
        name: "Legacy schedule",
        prompt: "Run the legacy schedule once",
        crons: ["0 0 9 * * *"],
        timezone: "UTC",
        notify: false,
        active: true,
        nextRunAt: legacyDueAt,
      },
    });
    await jobs.enqueue({
      name: "routine.wakeup",
      payload: { routineId: legacy.id, scheduledFor: legacyDueAt.toISOString() },
    });
    await waitForDatabase(async () => {
      const stored = await prisma.routine.findUnique({ where: { id: legacy.id } });
      return stored?.active === false && stored.nextRunAt === null;
    });
    expect(await prisma.run.count({ where: { botId: bot.id, trigger: "routine" } })).toBe(
      legacyRunsBefore + 1,
    );
  });

  it("5b: tool-created schedules wake in the creating group or 1:1 thread", async () => {
    const cookie = await signup(app, `schedule-dest-j-${stamp}@rakazo.test`, "Schedule Dest");
    const me = await rpc<Me>(app, cookie, "me");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Scheduler",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const peer = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Peer",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const dmThread = await prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const group = await rpc<{ id: string; threadId: string }>(app, cookie, "groups/create", {
      name: "Schedule room",
      botIds: [bot.id, peer.id],
    });
    const events = createThreadEvents(prisma);
    const scheduleDeps = { prisma, events, jobs };

    const groupCreated = await createScheduleFromTool(scheduleDeps, {
      spaceId: me.spaceId,
      botId: bot.id,
      userId: me.userId,
      threadId: group.threadId,
      name: "Group ping",
      prompt: "say group-reminder-ok",
      schedule: { delaySeconds: 30 },
    });
    expect(groupCreated).toMatchObject({ ok: true });
    if (!("ok" in groupCreated) || !groupCreated.ok)
      throw new Error("group schedule create failed");
    const groupRoutine = await prisma.routine.findUniqueOrThrow({
      where: { id: groupCreated.routineId },
    });
    expect(groupRoutine.threadId).toBe(group.threadId);
    expect(groupRoutine.crons).toEqual([ONCE_ROUTINE_CRON]);

    const groupDueAt = new Date(Date.now() - 1_000);
    await prisma.routine.update({
      where: { id: groupRoutine.id },
      data: { nextRunAt: groupDueAt },
    });
    await executor.wakeRoutine(groupRoutine.id, groupDueAt.toISOString());
    await waitForDatabase(async () => {
      const run = await prisma.run.findFirst({
        where: { routineId: groupRoutine.id, trigger: "routine" },
      });
      return run?.threadId === group.threadId;
    });
    const groupRun = await prisma.run.findFirstOrThrow({
      where: { routineId: groupRoutine.id, trigger: "routine" },
    });
    expect(groupRun.threadId).toBe(group.threadId);
    expect(groupRun.threadId).not.toBe(dmThread.id);
    expect(
      await prisma.event.count({
        where: {
          threadId: group.threadId,
          type: "routine.fired",
          runId: groupRun.id,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.event.count({
        where: {
          threadId: dmThread.id,
          type: "routine.fired",
          runId: groupRun.id,
        },
      }),
    ).toBe(0);

    const dmCreated = await createScheduleFromTool(scheduleDeps, {
      spaceId: me.spaceId,
      botId: bot.id,
      userId: me.userId,
      threadId: dmThread.id,
      name: "DM ping",
      prompt: "say dm-reminder-ok",
      schedule: { delaySeconds: 30 },
    });
    expect(dmCreated).toMatchObject({ ok: true });
    if (!("ok" in dmCreated) || !dmCreated.ok) throw new Error("dm schedule create failed");
    const dmRoutine = await prisma.routine.findUniqueOrThrow({
      where: { id: dmCreated.routineId },
    });
    expect(dmRoutine.threadId).toBe(dmThread.id);

    const dmDueAt = new Date(Date.now() - 1_000);
    await prisma.routine.update({
      where: { id: dmRoutine.id },
      data: { nextRunAt: dmDueAt },
    });
    await executor.wakeRoutine(dmRoutine.id, dmDueAt.toISOString());
    await waitForDatabase(async () => {
      const run = await prisma.run.findFirst({
        where: { routineId: dmRoutine.id, trigger: "routine" },
      });
      return run?.threadId === dmThread.id;
    });
    const dmRun = await prisma.run.findFirstOrThrow({
      where: { routineId: dmRoutine.id, trigger: "routine" },
    });
    expect(dmRun.threadId).toBe(dmThread.id);
    expect(
      await prisma.event.count({
        where: {
          threadId: dmThread.id,
          type: "routine.fired",
          runId: dmRun.id,
        },
      }),
    ).toBe(1);
  });

  it("allocates event and message cursors atomically under concurrent writes", async () => {
    const cookie = await signup(app, `sequence-j-${stamp}@rakazo.test`, "Sequence");
    const actor = await rpc<Me>(app, cookie, "me");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Sequencer",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const thread = await prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });

    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        appendEvent(prisma, {
          spaceId: actor.spaceId,
          threadId: thread.id,
          botId: bot.id,
          type: "thread.progress",
          payload: { delta: String(index) },
        }),
      ),
    );
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        createThreadMessage(prisma, {
          threadId: thread.id,
          role: "system",
          blocks: [{ kind: "meta", text: String(index) }],
        }),
      ),
    );

    const [events, messages] = await Promise.all([
      prisma.event.findMany({ where: { threadId: thread.id }, orderBy: { seq: "asc" } }),
      prisma.message.findMany({ where: { threadId: thread.id }, orderBy: { seq: "asc" } }),
    ]);
    expect(events.map((row) => row.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect(messages.map((row) => row.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it("6: fake, managed-sandbox emulator, and desktop executor run the same graphical task", async () => {
    const ctx = {
      operationId: "1",
      traceId: "1",
      spaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    };
    const fake = new FakeSandboxProvider();
    const managed = new ManagedSandboxEmulator();
    const desktop = new DesktopSandboxProvider();
    const a = await fake.provision({ botId: "ja", homePath: "/tmp/ja" }, ctx);
    const b = await managed.provision({ botId: "jb", homePath: "/tmp/jb" }, ctx);
    const c = await desktop.provision({ botId: "jc", homePath: "/tmp/jc" }, ctx);
    let out = "";
    for await (const event of fake.execute(a, { argv: ["echo", "same-task"] }, ctx)) {
      if (event.type === "stdout") out += event.data;
    }
    for await (const event of managed.execute(b, { argv: ["echo", "same-task"] }, ctx)) {
      if (event.type === "stdout") out += event.data;
    }
    for await (const event of desktop.execute(c, { argv: ["echo", "same-task"] }, ctx)) {
      if (event.type === "stdout") out += event.data;
    }
    expect(out.match(/same-task/g)?.length).toBe(3);
    await desktop.destroy(c, ctx);
  });

  it("7: destination write is independently inspectable and credentials stay out of the thread", async () => {
    const cookie = await signup(app, `dest-j-${stamp}@rakazo.test`, "Dest");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const before = connector.records.length;
    const secret = "test-openrouter-key-not-a-real-secret";
    await rpc(app, cookie, "models/connect", {
      provider: "openrouter",
      apiKey: secret,
      label: "test",
      modelId: "scripted",
    });
    await sendAndWait(app, cookie, bot.id, "write this to the destination crm as a note");
    expect(connector.records.length).toBeGreaterThan(before);
    const snap = await rpc<Snap>(app, cookie, "threads/get", { botId: bot.id });
    expect(JSON.stringify(snap)).not.toContain(secret);
    const inspect = await fetch(`http://127.0.0.1:${connector.port}/records`);
    const records = (await inspect.json()) as unknown[];
    expect(records.length).toBeGreaterThan(0);
  });

  it("8: retrying a completed effect does not duplicate the destination write", async () => {
    const cookie = await signup(app, `crash-j-${stamp}@rakazo.test`, "Crash");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const before = connector.records.length;
    const sent = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "write this to the destination crm as a note",
    });
    await waitFor(
      app,
      cookie,
      bot.id,
      (s) => !s.run || ["completed", "failed", "cancelled"].includes(s.run.status),
    );
    const afterFirst = connector.records.length;
    expect(afterFirst).toBeGreaterThan(before);
    await prisma.run.update({
      where: { id: sent.runId },
      data: { status: "running", completedAt: null },
    });
    await executor.continueRun(sent.runId, "retry");
    expect(connector.records.length).toBe(afterFirst);
  });

  it("9: export includes memory and files but not secrets or browser sessions", async () => {
    const cookie = await signup(app, `export-j-${stamp}@rakazo.test`, "Export");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "Be useful",
      notifyOnFinish: true,
    });
    const secret = "test-openrouter-key-not-a-real-secret";
    await rpc(app, cookie, "models/connect", {
      provider: "openrouter",
      apiKey: secret,
      label: "hidden",
      modelId: "scripted",
    });
    await sendAndWait(
      app,
      cookie,
      bot.id,
      "write a file in your home called notes/result.txt that says export-ok",
    );
    const manifest = await rpc<Record<string, unknown>>(app, cookie, "export/bot", {
      botId: bot.id,
    });
    const rawJson = JSON.stringify(manifest);
    expect(rawJson).toContain("export-ok");
    expect(rawJson).toContain("Be useful");
    expect(rawJson).not.toContain(secret);
    expect(rawJson).not.toMatch(/browserProfile|ciphertext|sessionCookie/i);
  });

  it("10: bots can be archived safely and deleted with or without their memories", async () => {
    const ada = await signup(app, `delete-j-${stamp}@rakazo.test`, "Delete Ada");
    const bob = await signup(app, `delete-bob-j-${stamp}@rakazo.test`, "Delete Bob");
    const keep = await rpc<Bot>(app, ada, "bots/create", {
      name: "Keep",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const gone = await rpc<Bot>(app, ada, "bots/create", {
      name: "Gone",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
      computerMode: "dedicated",
    });
    const forget = await rpc<Bot>(app, ada, "bots/create", {
      name: "Forget",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const goneMemory = await prisma.memoryDocument.findFirstOrThrow({ where: { botId: gone.id } });
    const forgetMemory = await prisma.memoryDocument.findFirstOrThrow({
      where: { botId: forget.id },
    });
    await prisma.memoryDocument.update({
      where: { id: goneMemory.id },
      data: { content: "important retained context" },
    });
    await sendAndWait(
      app,
      ada,
      gone.id,
      "write a file in your home called notes/result.txt that says delete-ok",
    );
    const goneArtifact = await rpc<{ id: string }>(app, ada, "artifacts/create", {
      botId: gone.id,
      name: "delete-me.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("fake artifact content").toString("base64"),
    });
    const home = path.join(dataDir, "homes", gone.id);
    expect(existsSync(home)).toBe(true);

    const stolen = await raw(app, bob, "bots/archive", { botId: gone.id });
    expect(stolen.status).toBeGreaterThanOrEqual(400);
    expect((await rpc<Bot[]>(app, ada, "bots/list")).map((bot) => bot.id)).toContain(gone.id);

    await rpc(app, ada, "bots/archive", { botId: gone.id });
    expect((await rpc<Bot[]>(app, ada, "bots/list")).map((bot) => bot.id)).not.toContain(gone.id);
    expect((await rpc<Bot[]>(app, ada, "bots/listArchived")).map((bot) => bot.id)).toContain(
      gone.id,
    );
    expect(await prisma.artifact.findUnique({ where: { id: goneArtifact.id } })).not.toBeNull();
    expect(existsSync(home)).toBe(true);

    await rpc(app, ada, "bots/restore", { botId: gone.id });
    expect((await rpc<Bot[]>(app, ada, "bots/list")).map((bot) => bot.id)).toContain(gone.id);

    await rpc(app, ada, "bots/remove", { botId: gone.id, deleteMemories: false });
    const list = await rpc<Bot[]>(app, ada, "bots/list");
    expect(list.map((bot) => bot.id)).toEqual(expect.arrayContaining([keep.id, forget.id]));
    expect((await raw(app, ada, "bots/get", { botId: gone.id })).status).toBeGreaterThanOrEqual(
      400,
    );
    expect(
      await prisma.memoryDocument.findUniqueOrThrow({ where: { id: goneMemory.id } }),
    ).toMatchObject({
      botId: null,
      scope: "user",
      content: "important retained context",
    });
    expect(await prisma.botDeletion.findUniqueOrThrow({ where: { id: gone.id } })).toMatchObject({
      memoriesPreserved: true,
    });
    expect(await prisma.artifact.findUnique({ where: { id: goneArtifact.id } })).toBeNull();
    expect(existsSync(home)).toBe(false);

    await rpc(app, ada, "bots/remove", { botId: forget.id, deleteMemories: true });
    expect(await prisma.memoryDocument.findUnique({ where: { id: forgetMemory.id } })).toBeNull();
  });

  it("11: deleting an account removes the user and personal workspace data", async () => {
    const email = `account-delete-j-${stamp}@rakazo.test`;
    const cookie = await signup(app, email, "Delete Account");
    const me = await rpc<Me>(app, cookie, "me");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Temporary",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });

    const deleted = await app.request("/api/auth/delete-user", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "http://127.0.0.1:5173",
      },
      body: JSON.stringify({ password: "password12" }),
    });

    expect(deleted.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: me.userId } })).toBeNull();
    expect(await prisma.organization.findUnique({ where: { id: me.spaceId } })).toBeNull();
    expect(await prisma.bot.findUnique({ where: { id: bot.id } })).toBeNull();
    expect((await raw(app, cookie, "me")).status).toBeGreaterThanOrEqual(400);
  });

  it("12: a bot can spawn a regular bot and must confirm the name to delete it", async () => {
    const cookie = await signup(app, `spawn-j-${stamp}@rakazo.test`, "Spawn");
    const parent = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await sendAndWait(app, cookie, parent.id, "spawn a bot named Scout to research venues");
    const listed = await rpc<Bot[]>(app, cookie, "bots/list");
    const scout = listed.find((bot) => bot.name === "Scout");
    expect(scout).toBeTruthy();
    expect(listed.map((bot) => bot.name).sort()).toEqual(["Chief", "Scout"]);
    await waitFor(
      app,
      cookie,
      scout!.id,
      (s) => !s.run || ["completed", "failed", "cancelled"].includes(s.run.status),
    );
    const snap = await rpc<Snap>(app, cookie, "threads/get", { botId: parent.id });
    expect(JSON.stringify(snap.messages)).toMatch(/child_bot|Scout/);

    await sendAndWait(app, cookie, scout!.id, "spawn a bot named Nested");
    const afterNested = await rpc<Bot[]>(app, cookie, "bots/list");
    const nested = afterNested.find((bot) => bot.name === "Nested");
    expect(nested).toBeTruthy();
    expect(afterNested.map((bot) => bot.name).sort()).toEqual(["Chief", "Nested", "Scout"]);
    await waitFor(
      app,
      cookie,
      nested!.id,
      (s) => !s.run || ["completed", "failed", "cancelled"].includes(s.run.status),
    );

    await sendAndWait(app, cookie, parent.id, "delete the bot named Nested");
    expect((await rpc<Bot[]>(app, cookie, "bots/list")).some((bot) => bot.id === nested!.id)).toBe(
      true,
    );

    await sendAndWait(app, cookie, parent.id, "delete the bot named WrongName");
    expect((await rpc<Bot[]>(app, cookie, "bots/list")).some((bot) => bot.id === scout!.id)).toBe(
      true,
    );

    await sendAndWait(app, cookie, parent.id, "delete the bot named Scout");
    const afterScout = await rpc<Bot[]>(app, cookie, "bots/list");
    expect(afterScout.some((bot) => bot.id === scout!.id)).toBe(false);
    expect(afterScout.some((bot) => bot.id === nested!.id)).toBe(true);

    await rpc(app, cookie, "bots/remove", { botId: parent.id });
    expect((await rpc<Bot[]>(app, cookie, "bots/list")).map((bot) => bot.name)).toEqual(["Nested"]);
  });

  it("13: a subagent shows up in the parent thread without creating a bot", async () => {
    const cookie = await signup(app, `subagent-j-${stamp}@rakazo.test`, "Subagent");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const before = (await rpc<Bot[]>(app, cookie, "bots/list")).length;
    const snap = await sendAndWait(app, cookie, bot.id, "run a subagent to summarize the notes");
    expect(JSON.stringify(snap.messages)).toMatch(/subagent|helper/);
    expect(await rpc<Bot[]>(app, cookie, "bots/list")).toHaveLength(before);
  });

  it("11: compose backup docs and dump tooling exist", async () => {
    expect(existsSync(path.resolve("docs/self-host.md"))).toBe(true);
    expect(existsSync(path.resolve("infra/compose/docker-compose.yml"))).toBe(true);
    expect(existsSync(path.resolve("scripts/backup.sh"))).toBe(true);
    expect(existsSync(path.resolve("scripts/restore.sh"))).toBe(true);
    const docs = readFileSync(path.resolve("docs/self-host.md"), "utf8");
    expect(docs).toMatch(/pg_dump/);
    expect(docs).toMatch(/Restore/);
  });

  it("14: this-mac is refused unless the sandbox is docker", async () => {
    const cookie = await signup(app, `host-j-${stamp}@rakazo.test`, "Host");
    const me = await rpc<Me>(app, cookie, "me");
    expect(me.canChooseHostComputer).toBe(false);
    await prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: me.userId },
    });
    const res = await raw(app, cookie, "deployment/update", { computerHost: "this-mac" });
    const text = await res.text();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(text).toMatch(/This Mac mode is only available/i);
  });

  it("15: ask, answer, stop, follow-up, and clientNonce stay consistent", async () => {
    const cookie = await signup(app, `ask-j-${stamp}@rakazo.test`, "Ask");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await rpc(app, cookie, "bots/update", { botId: bot.id, title: "Updated chief" });
    expect((await rpc<Bot>(app, cookie, "bots/get", { botId: bot.id })).title).toBe(
      "Updated chief",
    );

    const asked = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "ask me which city to use",
    });
    const waiting = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.status === "waiting_input",
    );
    expect(JSON.stringify(waiting.messages)).toMatch(/which city/i);
    const askMessage = waiting.messages.find((message) =>
      message.blocks.some((block) => block.kind === "ask"),
    );
    expect(askMessage).toBeTruthy();
    await rpc(app, cookie, "threads/answer", {
      botId: bot.id,
      runId: asked.runId,
      messageId: askMessage!.id,
      answer: "Paris",
    });
    const answered = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(answered.run?.status ?? "completed").toBe("completed");

    await rpc(app, cookie, "threads/send", {
      botId: bot.id,
      text: "keep working until I stop you",
    });
    await waitFor(app, cookie, bot.id, (snap) =>
      ["queued", "leased", "running"].includes(snap.run?.status ?? ""),
    );
    const hanging = await prisma.run.findFirstOrThrow({
      where: { botId: bot.id },
      orderBy: { createdAt: "desc" },
    });
    await rpc(app, cookie, "threads/stop", { botId: bot.id });
    await waitFor(app, cookie, bot.id, (snap) => !snap.run);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: hanging.id } })).status).toBe(
      "cancelled",
    );

    await rpc(app, cookie, "threads/followUp", {
      botId: bot.id,
      text: "write a file in your home called notes/result.txt that says followup-ok",
    });
    await waitFor(
      app,
      cookie,
      bot.id,
      (s) => !s.run || ["completed", "failed", "cancelled"].includes(s.run.status),
    );
    expect(
      (
        await rpc<{ content: string }>(app, cookie, "computer/readFile", {
          botId: bot.id,
          path: "notes/result.txt",
        })
      ).content,
    ).toContain("followup-ok");

    const first = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "write a file in your home called notes/result.txt that says nonce-ok",
      clientNonce: `nonce-${stamp}`,
    });
    const second = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "write a file in your home called notes/result.txt that says nonce-dup",
      clientNonce: `nonce-${stamp}`,
    });
    expect(second.runId).toBe(first.runId);
    await waitFor(
      app,
      cookie,
      bot.id,
      (s) => !s.run || ["completed", "failed", "cancelled"].includes(s.run.status),
    );
    const file = await rpc<{ content: string }>(app, cookie, "computer/readFile", {
      botId: bot.id,
      path: "notes/result.txt",
    });
    expect(file.content).toContain("nonce-ok");
    expect(file.content).not.toContain("nonce-dup");
  });

  it("16: routine test-run and plugin connect/revoke", async () => {
    const ada = await signup(app, `plug-j-${stamp}@rakazo.test`, "Plug Ada");
    const bob = await signup(app, `plug-bob-j-${stamp}@rakazo.test`, "Plug Bob");
    const bot = await rpc<Bot>(app, ada, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const routine = await rpc<{ id: string }>(app, ada, "routines/create", {
      botId: bot.id,
      name: "Test now",
      prompt: "write a file in your home called notes/result.txt that says testrun-ok",
      crons: ["0 9 * * 1"],
      timezone: "UTC",
      notify: false,
      active: false,
    });
    const tested = await rpc<{ runId: string }>(app, ada, "routines/testRun", {
      routineId: routine.id,
    });
    expect(tested.runId).toBeTruthy();
    await waitFor(
      app,
      ada,
      bot.id,
      (s) => !s.run || ["completed", "failed", "cancelled"].includes(s.run.status),
    );
    const file = await rpc<{ content: string }>(app, ada, "computer/readFile", {
      botId: bot.id,
      path: "notes/result.txt",
    });
    expect(file.content).toContain("testrun-ok");

    const started = await rpc<{ connectionId: string; authorizationUrl: string | null }>(
      app,
      ada,
      "connections/begin",
      { provider: "gmail", displayName: "Gmail" },
    );
    expect(started.authorizationUrl).toBeNull();
    const connected = await rpc<{ status: string }>(app, ada, "connections/complete", {
      connectionId: started.connectionId,
    });
    expect(connected.status).toBe("connected");
    await rpc(app, bob, "connections/revoke", { connectionId: started.connectionId });
    expect(
      (await rpc<Array<{ id: string; status: string }>>(app, ada, "connections/list")).find(
        (row) => row.id === started.connectionId,
      )?.status,
    ).toBe("connected");
    await rpc(app, ada, "connections/revoke", { connectionId: started.connectionId });
    expect(
      (await rpc<Array<{ id: string; status: string }>>(app, ada, "connections/list")).find(
        (row) => row.id === started.connectionId,
      )?.status,
    ).toBe("revoked");
  });

  it("54: group chats share one transcript with mentions and handoffs", async () => {
    const ada = await signup(app, `ada-g-${stamp}@rakazo.test`, "Ada Groups");
    const adaMe = await rpc<Me>(app, ada, "me");
    const botA = await rpc<Bot>(app, ada, "bots/create", {
      name: "BotA",
      title: "Researcher",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const botB = await rpc<Bot>(app, ada, "bots/create", {
      name: "BotB",
      title: "Writer",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const botC = await rpc<Bot>(app, ada, "bots/create", {
      name: "Writer",
      title: "Editor",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const botD = await rpc<Bot>(app, ada, "bots/create", {
      name: "Research Writer",
      title: "Analyst",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const group = await rpc<{ id: string; threadId: string; members: Array<{ botId: string }> }>(
      app,
      ada,
      "groups/create",
      { name: "Research squad", botIds: [botA.id, botB.id, botC.id, botD.id] },
    );
    const listed = await rpc<Array<{ id: string }>>(app, ada, "groups/list");
    expect(listed.some((row) => row.id === group.id)).toBe(true);
    expect((await rpc<Bot[]>(app, ada, "bots/list")).map((b) => b.id)).toEqual(
      expect.arrayContaining([botA.id, botB.id, botC.id, botD.id]),
    );

    await sendGroupAndWait(app, ada, group.id, "@BotA gather sources. @BotB summarize.");
    const mentioned = await rpc<Snap & { threadId: string }>(app, ada, "threads/get", {
      groupId: group.id,
    });
    expect(new Set(mentioned.messages.map((m) => m.seq)).size).toBeGreaterThan(0);
    const runsAfterMention = await prisma.run.findMany({
      where: { threadId: group.threadId, botId: { in: [botA.id, botB.id] } },
      orderBy: { createdAt: "desc" },
      take: 4,
    });
    expect(runsAfterMention.some((run) => run.botId === botA.id)).toBe(true);
    expect(runsAfterMention.some((run) => run.botId === botB.id)).toBe(true);

    const countUserRuns = async (botId: string) =>
      prisma.run.count({
        where: { threadId: group.threadId, trigger: "user", botId },
      });
    const botABefore = await countUserRuns(botA.id);
    const botBBefore = await countUserRuns(botB.id);
    const botCBefore = await countUserRuns(botC.id);
    const botDBefore = await countUserRuns(botD.id);
    await sendGroupAndWait(app, ada, group.id, "hello team");
    expect(
      (await countUserRuns(botA.id)) +
        (await countUserRuns(botB.id)) +
        (await countUserRuns(botC.id)) +
        (await countUserRuns(botD.id)),
    ).toBe(botABefore + botBBefore + botCBefore + botDBefore + 1);

    await sendGroupAndWait(app, ada, group.id, "@BotA hand this to Writer for the draft", botA.id);
    const handoffSnap = await rpc<Snap>(app, ada, "threads/get", { groupId: group.id });
    expect(
      handoffSnap.messages.some((message) =>
        (message.blocks as Array<{ kind?: string }>).some((block) => block.kind === "handoff"),
      ),
    ).toBe(true);

    const groupAsk = await rpc<{ runId: string }>(app, ada, "threads/send", {
      groupId: group.id,
      text: "@Research Writer ask me which city to use",
    });
    await waitForDatabase(async () => {
      const run = await prisma.run.findUnique({ where: { id: groupAsk.runId } });
      return run?.status === "waiting_input";
    });
    const groupsWithActiveMember = await rpc<
      Array<{ id: string; members: Array<{ botId: string; status?: string }> }>
    >(app, ada, "groups/list");
    expect(
      groupsWithActiveMember
        .find((listedGroup) => listedGroup.id === group.id)
        ?.members.find((member) => member.botId === botD.id)?.status,
    ).toBe("waiting_input");
    const activeGroupSnapshot = await rpc<{
      members?: Array<{ botId: string; status?: string }>;
    }>(app, ada, "threads/get", { groupId: group.id });
    expect(activeGroupSnapshot.members?.find((member) => member.botId === botD.id)?.status).toBe(
      "waiting_input",
    );
    const concurrentTask = await prisma.task.create({
      data: {
        spaceId: botA.spaceId,
        botId: botA.id,
        threadId: group.threadId,
        userId: adaMe.userId,
        prompt: "concurrent work",
        status: "running",
      },
    });
    const concurrentRun = await prisma.run.create({
      data: {
        spaceId: botA.spaceId,
        botId: botA.id,
        threadId: group.threadId,
        taskId: concurrentTask.id,
        userId: adaMe.userId,
        status: "running",
        trigger: "user",
        createdAt: new Date(Date.now() + 1_000),
      },
    });
    const askSnapshot = await rpc<Snap>(app, ada, "threads/get", { groupId: group.id });
    expect(askSnapshot.run?.id).toBe(concurrentRun.id);
    expect(askSnapshot.activeRuns?.some((run) => run.id === groupAsk.runId)).toBe(true);
    const askMessage = askSnapshot.messages.find(
      (message) =>
        message.runId === groupAsk.runId &&
        message.blocks.some((block) => block.kind === "ask" && block.status !== "answered"),
    );
    expect(askMessage).toBeTruthy();
    await rpc(app, ada, "threads/answer", {
      groupId: group.id,
      runId: groupAsk.runId,
      messageId: askMessage!.id,
      answer: "Paris",
    });
    await waitForDatabase(async () => {
      const run = await prisma.run.findUnique({ where: { id: groupAsk.runId } });
      return run?.status === "completed";
    });
    const answerEvent = await prisma.event.findFirstOrThrow({
      where: {
        threadId: group.threadId,
        runId: groupAsk.runId,
        type: "thread.message.updated",
      },
      orderBy: { seq: "desc" },
    });
    expect(answerEvent.botId).toBe(botD.id);
    await prisma.$transaction([
      prisma.run.update({
        where: { id: concurrentRun.id },
        data: { status: "cancelled", completedAt: new Date() },
      }),
      prisma.task.update({ where: { id: concurrentTask.id }, data: { status: "cancelled" } }),
    ]);

    const staleTask = await prisma.task.create({
      data: {
        spaceId: botB.spaceId,
        botId: botB.id,
        threadId: group.threadId,
        userId: adaMe.userId,
        prompt: "stale handoff",
        status: "running",
      },
    });
    const staleRun = await prisma.run.create({
      data: {
        spaceId: botB.spaceId,
        botId: botB.id,
        threadId: group.threadId,
        taskId: staleTask.id,
        userId: adaMe.userId,
        status: "running",
        trigger: "user",
      },
    });
    const replayNonce = `group-replay-${stamp}`;
    const firstSend = await rpc<{ runId: string; runIds?: string[] }>(app, ada, "threads/send", {
      groupId: group.id,
      text: "@BotA gather updates. @BotB compare them.",
      clientNonce: replayNonce,
    });
    await rpc(app, ada, "groups/update", {
      groupId: group.id,
      botIds: [botA.id, botC.id, botD.id],
    });
    expect((await prisma.run.findUniqueOrThrow({ where: { id: staleRun.id } })).status).toBe(
      "cancelled",
    );
    const replayedSend = await rpc<{ runId: string; runIds?: string[] }>(app, ada, "threads/send", {
      groupId: group.id,
      text: "this changed text must not create another message",
      clientNonce: replayNonce,
    });
    expect(replayedSend.runId).toBe(firstSend.runId);
    expect(replayedSend.runIds).toEqual(firstSend.runIds);
    const replayMessage = await prisma.message.findUniqueOrThrow({
      where: { threadId_clientNonce: { threadId: group.threadId, clientNonce: replayNonce } },
      include: { sourceRuns: true },
    });
    expect(replayMessage.sourceRuns).toHaveLength(1);
    await expect(
      prisma.steeringMessage.findUniqueOrThrow({
        where: { messageId_botId: { messageId: replayMessage.id, botId: botB.id } },
      }),
    ).resolves.toMatchObject({ runId: staleRun.id, claimedAt: null });
    expect(
      await prisma.message.count({ where: { threadId: group.threadId, clientNonce: replayNonce } }),
    ).toBe(1);
    const messageEvents = await prisma.event.findMany({
      where: { threadId: group.threadId, type: "thread.message.created" },
      select: { payload: true },
    });
    expect(
      messageEvents.filter(
        (event) => (event.payload as { messageId?: string } | null)?.messageId === replayMessage.id,
      ),
    ).toHaveLength(1);

    const staleHandoff = await handoffToGroupBot(
      { prisma, events: createThreadEvents(prisma), jobs },
      {
        id: staleRun.id,
        spaceId: botB.spaceId,
        threadId: group.threadId,
        botId: botB.id,
        userId: staleTask.userId,
      },
      group.id,
      { bot_id: botC.id, message: "should be rejected" },
    );
    expect(staleHandoff).toEqual({ error: "source run is no longer active" });

    const crossThread = await rpc<{ runId: string }>(app, ada, "threads/send", {
      botId: botC.id,
      text: "the same nonce is valid in a different thread",
      clientNonce: replayNonce,
    });
    expect(crossThread.runId).not.toBe(firstSend.runId);

    const attachmentText = "group attachment content";
    const artifact = await rpc<{ id: string }>(app, ada, "artifacts/create", {
      groupId: group.id,
      name: "group-note.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from(attachmentText).toString("base64"),
    });
    const attached = await rpc<{ runId: string }>(app, ada, "threads/send", {
      groupId: group.id,
      text: "@Research Writer inspect the attachment",
      artifactIds: [artifact.id],
    });
    await waitForDatabase(async () => {
      const run = await prisma.run.findUnique({ where: { id: attached.runId } });
      return Boolean(run && ["completed", "failed", "cancelled"].includes(run.status));
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: attached.runId } })).toMatchObject({
      botId: botD.id,
      status: "completed",
      error: null,
    });
    const downloaded = await rpc<{ contentBase64: string }>(app, ada, "artifacts/get", {
      groupId: group.id,
      artifactId: artifact.id,
    });
    expect(Buffer.from(downloaded.contentBase64, "base64").toString()).toBe(attachmentText);

    const artifactOwnerId = (
      await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } })
    ).botId;
    if (!artifactOwnerId) throw new Error("Group artifact is missing its uploader");
    const remainingGroupBotIds = [botA.id, botC.id, botD.id].filter(
      (botId) => botId !== artifactOwnerId,
    );
    expect(remainingGroupBotIds).toHaveLength(2);
    await rpc(app, ada, "groups/update", {
      groupId: group.id,
      botIds: remainingGroupBotIds,
    });
    await rpc(app, ada, "bots/remove", { botId: artifactOwnerId, deleteMemories: true });
    expect(await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).toMatchObject({
      botId: null,
      groupId: group.id,
    });
    const downloadedAfterUploaderRemoval = await rpc<{ contentBase64: string }>(
      app,
      ada,
      "artifacts/get",
      { groupId: group.id, artifactId: artifact.id },
    );
    expect(Buffer.from(downloadedAfterUploaderRemoval.contentBase64, "base64").toString()).toBe(
      attachmentText,
    );

    const archiveMember = await rpc<Bot>(app, ada, "bots/create", {
      name: "Archive Member",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const archivePartner = await rpc<Bot>(app, ada, "bots/create", {
      name: "Archive Partner",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const archiveGroup = await rpc<{ id: string }>(app, ada, "groups/create", {
      name: "Archive invariant",
      botIds: [archiveMember.id, archivePartner.id],
    });
    const archiveThread = await prisma.thread.findUniqueOrThrow({
      where: { groupId: archiveGroup.id },
      select: { id: true },
    });
    await rpc(app, ada, "bots/archive", { botId: archiveMember.id });
    expect(
      await prisma.chatGroup.findUniqueOrThrow({
        where: { id: archiveGroup.id },
        include: { members: true, thread: { select: { id: true } } },
      }),
    ).toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({ botId: archiveMember.id }),
        expect.objectContaining({ botId: archivePartner.id }),
      ]),
      thread: archiveThread,
    });
    const groupsWhileUndersized = await rpc<Array<{ id: string }>>(app, ada, "groups/list");
    expect(groupsWhileUndersized.some((row) => row.id === archiveGroup.id)).toBe(false);
    await expect(rpc(app, ada, "threads/get", { groupId: archiveGroup.id })).rejects.toThrow();
    await expect(
      rpc(app, ada, "threads/send", {
        groupId: archiveGroup.id,
        text: "This hidden group must not run with one active member",
      }),
    ).rejects.toThrow();
    await rpc(app, ada, "bots/restore", { botId: archiveMember.id });
    const restoredArchiveGroup = await rpc<
      Array<{ id: string; members: Array<{ botId: string }> }>
    >(app, ada, "groups/list");
    expect(restoredArchiveGroup.find((row) => row.id === archiveGroup.id)?.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ botId: archiveMember.id }),
        expect.objectContaining({ botId: archivePartner.id }),
      ]),
    );
    const archiveThird = await rpc<Bot>(app, ada, "bots/create", {
      name: "Archive Third",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await rpc(app, ada, "groups/update", {
      groupId: archiveGroup.id,
      botIds: [archiveMember.id, archivePartner.id, archiveThird.id],
    });
    await rpc(app, ada, "bots/archive", { botId: archiveMember.id });
    const dissolvingTask = await prisma.task.create({
      data: {
        spaceId: archivePartner.spaceId,
        botId: archivePartner.id,
        threadId: archiveThread.id,
        userId: adaMe.userId,
        prompt: "fake active work while deleting a group member",
        status: "running",
      },
    });
    const dissolvingRun = await prisma.run.create({
      data: {
        spaceId: archivePartner.spaceId,
        botId: archivePartner.id,
        threadId: archiveThread.id,
        taskId: dissolvingTask.id,
        userId: adaMe.userId,
        status: "running",
        trigger: "user",
      },
    });
    await rpc(app, ada, "bots/remove", { botId: archiveThird.id, deleteMemories: true });
    expect(await prisma.chatGroup.findUnique({ where: { id: archiveGroup.id } })).toBeNull();
    expect(await prisma.run.findUnique({ where: { id: dissolvingRun.id } })).toBeNull();
    await rpc(app, ada, "bots/restore", { botId: archiveMember.id });
    expect(await prisma.chatGroup.findUnique({ where: { id: archiveGroup.id } })).toBeNull();

    const deletionPartner = await rpc<Bot>(app, ada, "bots/create", {
      name: "Deletion Partner",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const deletionGroup = await rpc<{ id: string }>(app, ada, "groups/create", {
      name: "Deletion invariant",
      botIds: [botB.id, deletionPartner.id],
    });
    await expect(prisma.bot.delete({ where: { id: botB.id } })).rejects.toThrow();
    expect(await prisma.chatGroup.findUnique({ where: { id: deletionGroup.id } })).not.toBeNull();
    await rpc(app, ada, "bots/remove", { botId: botB.id, deleteMemories: true });
    expect(await prisma.chatGroup.findUnique({ where: { id: deletionGroup.id } })).toBeNull();

    await rpc(app, ada, "groups/remove", { groupId: group.id });
    expect(await prisma.artifact.findUnique({ where: { id: artifact.id } })).toBeNull();
    const remainingBotIds = (await rpc<Bot[]>(app, ada, "bots/list")).map((bot) => bot.id);
    expect(remainingBotIds).toEqual(
      expect.arrayContaining([
        ...remainingGroupBotIds,
        deletionPartner.id,
        archiveMember.id,
        archivePartner.id,
      ]),
    );
    expect(remainingBotIds).not.toContain(artifactOwnerId);
  });

  it("17: teach a task end to end", async () => {
    const cookie = await signup(app, `teach-j-${stamp}@rakazo.test`, "Teach Ada");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Teacher",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await rpc(app, cookie, "computer/boot", { botId: bot.id });
    await rpc(app, cookie, "computer/takeover", { botId: bot.id });
    void rpc(app, cookie, "threads/send", {
      botId: bot.id,
      text: "keep working until I stop you",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const skill = await rpc<{
      id: string;
      status: string;
      playbook: { steps: string[] };
      recording: { events: Array<{ kind: string }> };
    }>(app, cookie, "skills/start", {
      botId: bot.id,
      goal: "Export weekly CRM list",
    });
    expect(skill.status).toBe("recording");
    await rpc(app, cookie, "computer/input", {
      botId: bot.id,
      kind: "pointer",
      payload: { x: 120, y: 40, button: "left", type: "click" },
    });
    await rpc(app, cookie, "computer/input", {
      botId: bot.id,
      kind: "key",
      payload: { key: "x" },
    });
    const blocked = await raw(app, cookie, "threads/send", {
      botId: bot.id,
      text: "please act now",
    });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    const stopped = await rpc<{
      status: string;
      playbook: { steps: string[] };
      recording: { events: Array<{ kind: string }>; snapshots: Array<{ summary: string }> };
    }>(app, cookie, "skills/stop", { skillId: skill.id });
    expect(stopped.status).toBe("draft");
    expect(stopped.playbook.steps.join(" ")).toMatch(/Click|120|40|x/i);
    expect(stopped.recording.events.some((event) => event.kind === "pointer")).toBe(true);
    expect(stopped.recording.snapshots.length).toBeGreaterThanOrEqual(2);
    const computerAfterStop = await rpc<{ controlHolder: string; controlBotId: string | null }>(
      app,
      cookie,
      "computer/status",
      { botId: bot.id },
    );
    expect(computerAfterStop.controlHolder).toBe("bot");
    expect(computerAfterStop.controlBotId).toBeNull();
    await rpc(app, cookie, "skills/updateDraft", {
      skillId: skill.id,
      name: "Export weekly CRM list",
      playbook: stopped.playbook,
    });
    const saved = await rpc<{ status: string; name: string }>(app, cookie, "skills/save", {
      skillId: skill.id,
      name: "Export weekly CRM list",
    });
    expect(saved.status).toBe("saved");
    const listed = await rpc<Array<{ id: string; name: string }>>(app, cookie, "skills/list", {
      botId: bot.id,
    });
    expect(listed.some((row) => row.id === skill.id)).toBe(true);
    const testRun = await rpc<{ runId: string }>(app, cookie, "skills/testRun", {
      skillId: skill.id,
    });
    expect(testRun.runId).toBeTruthy();
    await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    await sendAndWait(app, cookie, bot.id, "run Export weekly CRM list");
    const messages = (await rpc<Snap>(app, cookie, "threads/get", { botId: bot.id })).messages;
    const botText = JSON.stringify(messages);
    expect(botText.toLowerCase()).toContain("taught skill");
  });

  it("18: teaching expiry auto-stops recording", async () => {
    const previousTtl = process.env.TEACH_RECORDING_TTL_MS;
    process.env.TEACH_RECORDING_TTL_MS = "1000";
    try {
      const cookie = await signup(app, `teach-exp-j-${stamp}@rakazo.test`, "Teach Exp Ada");
      const bot = await rpc<Bot>(app, cookie, "bots/create", {
        name: "Timer",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: true,
      });
      await rpc(app, cookie, "computer/boot", { botId: bot.id });
      await rpc(app, cookie, "computer/takeover", { botId: bot.id });
      const skill = await rpc<{ id: string; status: string }>(app, cookie, "skills/start", {
        botId: bot.id,
        goal: "Timed demo",
      });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const current = await rpc<{ status: string }>(app, cookie, "skills/get", {
        skillId: skill.id,
      });
      expect(["draft", "drafting"].includes(current.status)).toBe(true);
    } finally {
      if (previousTtl === undefined) delete process.env.TEACH_RECORDING_TTL_MS;
      else process.env.TEACH_RECORDING_TTL_MS = previousTtl;
    }
  });

  it("19: destination writes pause for approval before side effects", async () => {
    const cookie = await signup(app, `approval-j-${stamp}@rakazo.test`, "Approval");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const recordsBefore = connector.records.length;
    await rpc(app, cookie, "approvalRules/set", {
      effect: "require_approval",
      matchKind: "tool",
      matchValue: "destination.write",
    });

    const sent = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "write this to the destination crm as a note",
    });
    const waiting = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.status === "waiting_input",
    );
    expect(JSON.stringify(waiting.messages)).toMatch(/allow once|review before/i);
    expect(connector.records).toHaveLength(recordsBefore);
    await answerPendingApproval(app, cookie, bot.id, sent.runId, "allow", waiting);
    await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(connector.records.length).toBeGreaterThan(recordsBefore);

    const task = await prisma.task.findFirstOrThrow({
      where: { runs: { some: { id: sent.runId } } },
    });
    expect(task.prompt).toBe("write this to the destination crm as a note");

    const recordsAfterAllow = connector.records.length;
    const second = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "write this to the destination crm as a note again",
    });
    const waitingAgain = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.status === "waiting_input",
    );
    await answerPendingApproval(app, cookie, bot.id, second.runId, "deny", waitingAgain);
    const denied = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(connector.records).toHaveLength(recordsAfterAllow);
    expect(denied.run?.status ?? "completed").toBe("completed");
    const deniedEffect = await prisma.externalEffect.findFirst({
      where: { runId: second.runId, kind: "destination.write" },
    });
    expect(deniedEffect?.status).toBe("denied");
  });

  it("20: actions run by default and specific exceptions override broad review rules", async () => {
    const cookie = await signup(app, `always-j-${stamp}@rakazo.test`, "Always");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const prompt = "write this to the destination crm as a note";
    const recordsBefore = connector.records.length;

    await sendAndWait(app, cookie, bot.id, prompt);
    expect(connector.records.length).toBeGreaterThan(recordsBefore);
    const recordsAfterDefault = connector.records.length;

    await rpc(app, cookie, "approvalRules/set", {
      effect: "require_approval",
      matchKind: "connector",
      matchValue: "destination.write",
    });
    const second = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "write this to the destination crm as a note again",
    });
    const waiting = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.status === "waiting_input",
    );
    await answerPendingApproval(app, cookie, bot.id, second.runId, "always", waiting);
    await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(connector.records.length).toBe(recordsAfterDefault + 1);

    await sendAndWait(app, cookie, bot.id, "write this to the destination crm once more");
    expect(connector.records.length).toBe(recordsAfterDefault + 2);

    await rpc(app, cookie, "approvalRules/set", {
      effect: "require_approval",
      matchKind: "tool",
      matchValue: "destination.write",
    });
    const fourth = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "write this to the destination crm one final time",
    });
    const waitingAgain = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.status === "waiting_input",
    );
    expect(connector.records.length).toBe(recordsAfterDefault + 2);
    await answerPendingApproval(app, cookie, bot.id, fourth.runId, "allow", waitingAgain);
    await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(connector.records.length).toBe(recordsAfterDefault + 3);
  });

  it("21: routine destination writes pause on the same approval card", async () => {
    const cookie = await signup(app, `routine-approval-j-${stamp}@rakazo.test`, "Routine Approval");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await rpc(app, cookie, "approvalRules/set", {
      effect: "require_approval",
      matchKind: "tool",
      matchValue: "destination.write",
    });
    const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
      botId: bot.id,
      name: "Send note",
      prompt: "write this to the destination crm as a note",
      crons: ["0 9 * * 1"],
      timezone: "UTC",
      notify: false,
      active: false,
    });
    const recordsBefore = connector.records.length;
    const tested = await rpc<{ runId: string }>(app, cookie, "routines/testRun", {
      routineId: routine.id,
    });
    const waiting = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.status === "waiting_input",
    );
    expect(connector.records).toHaveLength(recordsBefore);
    await answerPendingApproval(app, cookie, bot.id, tested.runId, "allow", waiting);
    await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(connector.records.length).toBeGreaterThan(recordsBefore);
  });

  it("22: a routine schedule with any malformed or mixed one-shot cron is rejected", async () => {
    const cookie = await signup(app, `routine-crons-j-${stamp}@rakazo.test`, "Routine Crons");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Scheduler",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const partiallyInvalid = await raw(app, cookie, "routines/create", {
      botId: bot.id,
      name: "Bad schedule",
      prompt: "check the fixture",
      crons: ["0 9 * * *", "not-a-cron"],
      timezone: "UTC",
      notify: false,
      active: true,
    });
    expect(partiallyInvalid.status).toBeGreaterThanOrEqual(400);
    const mixedOneShot = await raw(app, cookie, "routines/create", {
      botId: bot.id,
      name: "Mixed schedule",
      prompt: "check the fixture",
      crons: ["@once", "0 9 * * *"],
      timezone: "UTC",
      notify: false,
      active: false,
    });
    expect(mixedOneShot.status).toBeGreaterThanOrEqual(400);
  });

  it("23: never-run one-shot templates can be armed with a future runAt", async () => {
    const cookie = await signup(app, `once-arm-j-${stamp}@rakazo.test`, "Once Arm");
    const me = await rpc<Me>(app, cookie, "me");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Once Bot",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const routine = await prisma.routine.create({
      data: {
        spaceId: me.spaceId,
        userId: me.userId,
        botId: bot.id,
        name: "Remind once",
        prompt: "Ping me once",
        crons: ["@once"],
        timezone: "UTC",
        notify: true,
        active: false,
        nextRunAt: null,
      },
    });

    const withoutTime = await raw(app, cookie, "routines/update", {
      routineId: routine.id,
      active: true,
    });
    expect(withoutTime.status).toBeGreaterThanOrEqual(400);

    const runAt = new Date(Date.now() + 120_000).toISOString();
    const armed = await rpc<{ active: boolean; nextRunAt: string | null }>(
      app,
      cookie,
      "routines/update",
      {
        routineId: routine.id,
        active: true,
        runAt,
      },
    );
    expect(armed.active).toBe(true);
    expect(armed.nextRunAt).toBe(runAt);

    await prisma.routine.update({
      where: { id: routine.id },
      data: { active: false, nextRunAt: null, lastRunAt: new Date() },
    });
    const afterFire = await raw(app, cookie, "routines/update", {
      routineId: routine.id,
      active: true,
      runAt: new Date(Date.now() + 180_000).toISOString(),
    });
    expect(afterFire.status).toBeGreaterThanOrEqual(400);
  });

  it("24: chat creates a space only after explicit approval", async () => {
    const cookie = await signup(app, `space-chat-j-${stamp}@rakazo.test`, "Space Chat");
    const me = await rpc<Me>(app, cookie, "me");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const membershipsBefore = await prisma.spaceMember.count({ where: { userId: me.userId } });
    const sent = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "create a space named Customer support",
    });
    const waiting = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.id === sent.runId && snap.run.status === "waiting_input",
    );
    const approval = JSON.stringify(waiting.messages);
    expect(approval).toContain("Create space");
    expect(approval).toContain("Customer support");
    expect(approval).toContain("Cancel");
    expect(approval).not.toContain("Always allow this tool");
    expect(await prisma.spaceMember.count({ where: { userId: me.userId } })).toBe(
      membershipsBefore,
    );

    await answerPendingApproval(app, cookie, bot.id, sent.runId, "allow", waiting);
    await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    const navigation = await rpc<{ spaces: Array<{ name: string }> }>(app, cookie, "spaces/list");
    expect(navigation.spaces.map((space) => space.name)).toContain("Customer support");
    expect(await prisma.spaceMember.count({ where: { userId: me.userId } })).toBe(
      membershipsBefore + 1,
    );

    const denied = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "create a space named Finance",
    });
    const deniedWaiting = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.id === denied.runId && snap.run.status === "waiting_input",
    );
    await answerPendingApproval(app, cookie, bot.id, denied.runId, "deny", deniedWaiting);
    await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
    );
    expect(await prisma.spaceMember.count({ where: { userId: me.userId } })).toBe(
      membershipsBefore + 1,
    );
  });
});

type Me = { spaceId: string; userId: string; canChooseHostComputer: boolean };
type Bot = {
  id: string;
  name: string;
  title: string;
  description: string;
  instructions: string;
  notifyOnFinish: boolean;
  color: string;
  pinned: boolean;
  sectionId: string | null;
  unread: boolean;
  computerMode: "team" | "dedicated";
  parentBotId?: string | null;
};
type Snap = {
  messages: Array<{
    id: string;
    seq: number;
    runId?: string | null;
    blocks: Array<{ kind?: string; status?: string; actions?: unknown[] }>;
  }>;
  run: { id: string; status: string } | null;
  activeRuns?: Array<{ id: string; status: string }>;
};

async function signup(app: App, email: string, name: string) {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (res.status >= 400) {
    throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  }
  return sessionCookieHeader(res);
}

async function raw(app: App, cookie: string, proc: string, body: unknown = {}) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await raw(app, cookie, proc, body);
  const text = await res.text();
  let parsed: { json?: T; error?: { message?: string } };
  try {
    parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  } catch {
    throw new Error(`${proc} ${res.status}: ${text}`);
  }
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}

async function answerPendingApproval(
  app: App,
  cookie: string,
  botId: string,
  runId: string,
  answer: "allow" | "always" | "deny",
  current?: Snap,
) {
  const waiting =
    current ??
    (await waitFor(
      app,
      cookie,
      botId,
      (snap) => snap.run?.id === runId && snap.run.status === "waiting_input",
    ));
  const message = [...waiting.messages]
    .reverse()
    .find(
      (candidate) =>
        candidate.runId === runId &&
        candidate.blocks.some(
          (block) =>
            typeof block === "object" &&
            block !== null &&
            "kind" in block &&
            block.kind === "ask" &&
            "approvalEffectId" in block &&
            typeof block.approvalEffectId === "string" &&
            "actions" in block &&
            Array.isArray(block.actions),
        ),
    );
  if (!message) throw new Error(`run ${runId} did not expose an approval card`);
  await rpc(app, cookie, "threads/answer", {
    botId,
    runId,
    messageId: message.id,
    answer,
  });
}

async function waitFor(app: App, cookie: string, botId: string, pred: (snap: Snap) => boolean) {
  const start = Date.now();
  let last: Snap | null = null;
  while (Date.now() - start < 20_000) {
    last = await rpc<Snap>(app, cookie, "threads/get", { botId });
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for thread: ${JSON.stringify(last)}`);
}

async function waitForDatabase(pred: () => Promise<boolean>) {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if (await pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for database state");
}
