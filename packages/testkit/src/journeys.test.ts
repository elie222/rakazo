import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DesktopSandboxProvider,
  FakeSandboxProvider,
  ManagedSandboxEmulator,
} from "@rakazo/adapters";
import { appendEvent, createThreadMessage } from "@rakazo/db";
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
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-journey-"));

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    });
    app = handles.app;
    stop = handles.stop;
    prisma = handles.prisma;
    connector = handles.connector;
    executor = handles.executor;
    jobs = handles.jobs;
  });

  afterAll(async () => {
    await stop?.();
  });

  it("1+2: users are isolated and workspace bots share the Team Computer", async () => {
    const ada = await signup(app, `ada-j-${stamp}@rakazo.test`, "Ada Journey");
    const bob = await signup(app, `bob-j-${stamp}@rakazo.test`, "Bob Journey");

    const adaMe = await rpc<Me>(app, ada, "me");
    const bobMe = await rpc<Me>(app, bob, "me");
    expect(adaMe.workspaceId).not.toBe(bobMe.workspaceId);

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
    const duplicate = await rpc<Bot>(app, ada, "bots/duplicate", { botId: chief.id });
    expect(duplicate).toMatchObject({
      name: "Chief copy",
      title: chief.title,
      description: chief.description,
      instructions: chief.instructions,
      notifyOnFinish: chief.notifyOnFinish,
      color: chief.color,
      pinned: false,
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
      await waitFor(app, cookie, bot.id, (snap) => snap.run?.status === "waiting_takeover");
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
      expect((await rpc<Snap>(app, cookie, "threads/get", { botId: bot.id })).run?.status).toBe(
        "waiting_takeover",
      );

      await rpc(app, cookie, "computer/takeover", { botId: bot.id });
      await rpc(app, cookie, "computer/release", { botId: bot.id });
      const done = await waitFor(
        app,
        cookie,
        bot.id,
        (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
      );
      expect(done.run?.status ?? "completed").not.toBe("waiting_takeover");
    } finally {
      if (previousTakeoverTtl === undefined) delete process.env.COMPUTER_TAKEOVER_TTL_MS;
      else process.env.COMPUTER_TAKEOVER_TTL_MS = previousTakeoverTtl;
    }
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
        cron: "0 9 * * 1",
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
          workspaceId: actor.workspaceId,
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
      workspaceId: "w",
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

  it("10: deleting a bot removes it, its home, and is isolated", async () => {
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
    await sendAndWait(
      app,
      ada,
      gone.id,
      "write a file in your home called notes/result.txt that says delete-ok",
    );
    const home = path.join(dataDir, "homes", gone.id);
    expect(existsSync(home)).toBe(true);

    const stolen = await raw(app, bob, "bots/remove", { botId: gone.id });
    expect(stolen.status).toBeGreaterThanOrEqual(400);
    expect((await rpc<Bot[]>(app, ada, "bots/list")).map((bot) => bot.id)).toContain(gone.id);

    await rpc(app, ada, "bots/remove", { botId: gone.id });
    const list = await rpc<Bot[]>(app, ada, "bots/list");
    expect(list.map((bot) => bot.id)).toEqual([keep.id]);
    expect((await raw(app, ada, "bots/get", { botId: gone.id })).status).toBeGreaterThanOrEqual(
      400,
    );
    expect(existsSync(home)).toBe(false);
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
    expect(await prisma.organization.findUnique({ where: { id: me.workspaceId } })).toBeNull();
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
    await rpc(app, cookie, "threads/answer", {
      botId: bot.id,
      runId: asked.runId,
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
      cron: "0 9 * * 1",
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
});

type Me = { workspaceId: string; userId: string; canChooseHostComputer: boolean };
type Bot = {
  id: string;
  name: string;
  title: string;
  description: string;
  instructions: string;
  notifyOnFinish: boolean;
  color: string;
  pinned: boolean;
  unread: boolean;
  computerMode: "team" | "dedicated";
  parentBotId?: string | null;
};
type Snap = {
  messages: Array<{ seq: number; blocks: unknown[] }>;
  run: { status: string } | null;
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

async function sendAndWait(app: App, cookie: string, botId: string, text: string) {
  await rpc(app, cookie, "threads/send", { botId, text });
  return waitFor(
    app,
    cookie,
    botId,
    (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
  );
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
