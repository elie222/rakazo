import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { createApp } from "@rakazo/api/app";
import type {
  Actor,
  Bot,
  ServiceCredential,
  ServiceRouteDefinition,
  ServiceScope,
} from "@rakazo/contracts";
import { SERVICE_API_PREFIX, SERVICE_ROUTES, SERVICE_SCOPES } from "@rakazo/contracts";
import { isOwnerStartedRun } from "@rakazo/core";
import { createPendingSteeringRun } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";
process.env.TICKET_BOARD_ENABLED = "true";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;
const ORIGIN = "http://127.0.0.1:5173";
const ROUTES = Object.entries(SERVICE_ROUTES) as Array<[string, ServiceRouteDefinition]>;
const EVERY_SCOPE = [...SERVICE_SCOPES] as ServiceScope[];

describeWithDatabase("service API surface", () => {
  let handles: AppHandles;
  let app: App;
  let db: AppHandles["prisma"];
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-service-surface-"));
  let sequence = 0;
  const answered = new Set<string>();

  const rpc = async <T>(cookie: string, procedure: string, body: unknown = {}) => {
    const response = await app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: ORIGIN },
      body: JSON.stringify({ json: body }),
    });
    const payload = (await response.json()) as { json?: T };
    if (response.status >= 400) throw new Error(`${procedure} ${response.status}`);
    return discardBotIntroFromCreate(
      handles as BotIntroHarness,
      cookie,
      procedure,
      payload.json as T,
    );
  };
  const person = async () => {
    sequence += 1;
    const response = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        email: `surface-${sequence}-${stamp}@rakazo.test`,
        password: "password12",
        name: `Surface ${sequence}`,
      }),
    });
    const cookie = sessionCookieHeader(response);
    await app.request("/api/auth/confirm-identity", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: ORIGIN },
      body: JSON.stringify({ password: "password12" }),
    });
    return { cookie, actor: await rpc<Actor>(cookie, "me") };
  };
  const newBot = (cookie: string, name: string) =>
    rpc<Bot>(cookie, "bots/create", {
      name,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
  const newKey = (cookie: string, scopes: ServiceScope[] = EVERY_SCOPE, botIds: string[] = []) =>
    rpc<{ credential: ServiceCredential; token: string }>(cookie, "serviceCredentials/create", {
      name: `key-${crypto.randomUUID().slice(0, 8)}`,
      scopes,
      botIds,
      expiresInDays: 30,
    });

  const api = async <T = Record<string, never>>(
    token: string | null,
    method: string,
    suffix: string,
    options: { body?: unknown; key?: string } = {},
  ) => {
    const response = await app.request(`${SERVICE_API_PREFIX}${suffix}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.key ? { "idempotency-key": options.key } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    if (response.status === 200) {
      const route = ROUTES.find(
        ([, definition]) =>
          definition.method === method &&
          new RegExp(`^${definition.path.replace(/:[A-Za-z]+/g, "[^/]+")}$`).test(
            suffix.split("?")[0] ?? "",
          ),
      );
      if (route) answered.add(route[0]);
    }
    return {
      status: response.status,
      headers: response.headers,
      json: (text ? JSON.parse(text) : null) as T & { error?: { code: string } },
    };
  };
  const ok = async <T = Record<string, never>>(...args: Parameters<typeof api>): Promise<T> => {
    const result = await api<T>(...args);
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    return result.json;
  };

  /** Fills path parameters so every route can be reached by a table-driven check. */
  const concrete = (definition: ServiceRouteDefinition, botId: string) =>
    definition.path.replace(/:([A-Za-z]+)/g, (_, name: string) =>
      name === "botId" ? botId : "absent",
    );

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      encryptionKey: "offline-service-surface-encryption-key",
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
    });
    app = handles.app;
    db = asSystem(handles.prisma);
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const threadOf = async (cookie: string, botId: string) =>
    (await rpc<{ threadId: string }>(cookie, "threads/head", { botId })).threadId;

  /** Work with no worker behind it, so the bot stays busy for as long as a test needs. */
  const busyRun = async (threadId: string) => {
    const thread = await db.thread.findUniqueOrThrow({ where: { id: threadId } });
    if (!thread.botId) throw new Error("expected a bot's thread");
    const owner = { spaceId: thread.spaceId, userId: thread.userId, botId: thread.botId, threadId };
    const task = await db.task.create({
      data: { ...owner, prompt: "the owner's work", status: "running" },
    });
    const run = await db.run.create({
      data: { ...owner, taskId: task.id, status: "running", trigger: "user" },
    });
    return { runId: run.id };
  };

  describe("every route", () => {
    it("refuses a call with no key", async () => {
      for (const [id, definition] of ROUTES) {
        const result = await api(null, definition.method, concrete(definition, "absent"));
        expect(result.status, id).toBe(401);
      }
    });

    it("refuses a key without its scope", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Scoped");
      const tokens = new Map<ServiceScope, string>();
      for (const [id, definition] of ROUTES) {
        if (!definition.scope) continue;
        const others = EVERY_SCOPE.filter((scope) => scope !== definition.scope);
        const token = tokens.get(definition.scope) ?? (await newKey(cookie, others)).token;
        tokens.set(definition.scope, token);
        const result = await api(token, definition.method, concrete(definition, bot.id));
        expect([id, result.status, result.json.error?.code]).toEqual([id, 403, "forbidden"]);
      }
    });

    it("keeps a bot-limited key on its bots", async () => {
      const { cookie } = await person();
      const allowed = await newBot(cookie, "Allowed");
      const other = await newBot(cookie, "Other");
      const { token } = await newKey(cookie, EVERY_SCOPE, [allowed.id]);
      for (const [id, definition] of ROUTES) {
        const result = await api(token, definition.method, concrete(definition, other.id), {
          ...(definition.idempotency ? { key: "limited" } : {}),
          ...(definition.body ? { body: {} } : {}),
        });
        if (definition.spaceWide) {
          expect([id, result.status, result.json.error?.code]).toEqual([
            id,
            403,
            "bot_limited_key",
          ]);
        } else if (definition.path.includes(":botId")) {
          // A body check may answer first; nothing may reach the other bot.
          expect([id, [400, 404].includes(result.status)]).toEqual([id, true]);
          if (!definition.body) expect([id, result.status]).toEqual([id, 404]);
        }
      }
    });

    it("gives a stable shape to every refusal and names the request", async () => {
      const { cookie } = await person();
      const { token } = await newKey(cookie, ["bots:read"]);
      const refused = await api(token, "POST", "/bots", { body: {}, key: "x" });
      expect(refused.status).toBe(403);
      expect(refused.json).toEqual({
        error: { code: "forbidden", message: expect.any(String) },
      });
      expect(refused.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
      expect(refused.headers.get("x-ratelimit-limit")).toBe("120");
      expect(Number(refused.headers.get("x-ratelimit-remaining"))).toBeGreaterThan(100);
    });
  });

  describe("what stays out", () => {
    it("publishes no route for approvals, answers, secrets or managing keys", () => {
      for (const [id, definition] of ROUTES) {
        expect([
          id,
          /answer|approv|secret|vault|credential|billing|deployment|updater\b/i.test(
            `${id} ${definition.path}`,
          ),
        ]).toEqual([id, false]);
      }
    });

    it("will not write settings that widen what a bot may reach", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Fenced");
      const { token } = await newKey(cookie);
      for (const body of [
        { crossSpaceCommunication: true },
        { fleetManagement: true },
        { disabledBuiltinTools: [] },
        { memoryScope: "shared" },
      ]) {
        expect((await api(token, "PATCH", `/bots/${bot.id}`, { body })).status).toBe(400);
      }
      for (const body of [
        { name: "w", prompt: "p", crons: ["0 9 * * *"], webhookEnabled: true },
        { name: "w", prompt: "p", crons: ["0 9 * * *"], githubEnabled: true },
      ]) {
        const result = await api(token, "POST", `/bots/${bot.id}/routines`, {
          body,
          key: crypto.randomUUID(),
        });
        expect(result.status).toBe(400);
      }
    });

    it("returns only the allowlisted fields of a conversation", async () => {
      const { cookie, actor } = await person();
      const bot = await newBot(cookie, "Quiet");
      const { token } = await newKey(cookie);
      const { threadId } = await rpc<{ threadId: string }>(cookie, "threads/head", {
        botId: bot.id,
      });
      await db.message.create({
        data: {
          threadId,
          seq: 5000,
          role: "bot",
          botId: bot.id,
          blocks: [
            { kind: "text", text: "visible" },
            { kind: "card", lines: [{ k: "private tool step", v: "done" }] },
            { kind: "steps", steps: [{ label: "private reasoning", count: 1 }] },
            {
              kind: "ask",
              text: "password?",
              input: "secret",
              answer: "hunter2",
              status: "answered",
            },
          ],
        },
      } as never);
      const raw = JSON.stringify(await ok(token, "GET", `/bots/${bot.id}/activity`));
      expect(raw).toContain("visible");
      expect(raw).toContain("password?");
      expect(raw).not.toContain("hunter2");
      expect(raw).not.toContain("private tool step");
      expect(raw).not.toContain("private reasoning");
      void actor;
    });
  });

  describe("keys acting on bots", () => {
    it("creates, reads, changes, archives and restores a bot", async () => {
      const { cookie } = await person();
      const { token } = await newKey(cookie);
      const created = await ok<{ id: string; instructions: string }>(token, "POST", "/bots", {
        body: { name: "From a key", instructions: "first" },
        key: "bot-1",
      });
      expect(created.instructions).toBe("first");

      const changed = await ok<{ name: string; instructions: string }>(
        token,
        "PATCH",
        `/bots/${created.id}`,
        { body: { name: "Renamed", instructions: "second" } },
      );
      expect(changed).toMatchObject({ name: "Renamed", instructions: "second" });
      const stale = await api(token, "PATCH", `/bots/${created.id}`, {
        body: { instructions: "third", expectedInstructions: "first" },
      });
      expect(stale.status).toBe(409);

      await ok(token, "POST", `/bots/${created.id}/archive`);
      expect((await api(token, "GET", `/bots/${created.id}`)).status).toBe(404);
      const archived = await ok<{ bots: Array<{ id: string }> }>(
        token,
        "GET",
        "/bots?archived=true",
      );
      expect(archived.bots.map((bot) => bot.id)).toContain(created.id);
      await ok(token, "POST", `/bots/${created.id}/restore`);
      expect((await api(token, "GET", `/bots/${created.id}`)).status).toBe(200);
    });

    it("replays a retried create, refuses a changed one, and frees a refused key", async () => {
      const { cookie, actor } = await person();
      const { token } = await newKey(cookie);
      const body = { name: "Once" };
      const first = await api<{ id: string }>(token, "POST", "/bots", { body, key: "once" });
      const again = await api<{ id: string }>(token, "POST", "/bots", { body, key: "once" });
      expect(again.status).toBe(200);
      expect(again.json.id).toBe(first.json.id);
      expect(again.headers.get("idempotent-replayed")).toBe("true");
      expect(await db.bot.count({ where: { spaceId: actor.spaceId, name: "Once" } })).toBe(1);

      const changed = await api(token, "POST", "/bots", { body: { name: "Twice" }, key: "once" });
      expect(changed.status).toBe(409);
      expect(changed.json.error?.code).toBe("idempotency_conflict");

      expect((await api(token, "POST", "/bots", { body })).json.error?.code).toBe(
        "idempotency_key_required",
      );
      expect((await api(token, "GET", "/bots", { key: "not-here" })).status).toBe(400);

      const refused = await api(token, "POST", `/tickets`, {
        body: { title: "t", assigneeBotId: "absent" },
        key: "free",
      });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(await db.serviceIdempotencyKey.count({ where: { key: "free" } })).toBe(0);
    });

    it("runs a routine's whole life and keeps it on its own bot", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Scheduled");
      const other = await newBot(cookie, "Neighbour");
      const { token } = await newKey(cookie);
      const routine = await ok<{ id: string; active: boolean }>(
        token,
        "POST",
        `/bots/${bot.id}/routines`,
        {
          body: { name: "Daily", prompt: "report", crons: ["0 9 * * *"] },
          key: "routine-1",
        },
      );
      const listed = await ok<{ routines: Array<{ id: string }> }>(
        token,
        "GET",
        `/bots/${bot.id}/routines`,
      );
      expect(listed.routines.map((entry) => entry.id)).toEqual([routine.id]);
      expect(
        (
          await ok<{ name: string }>(token, "PATCH", `/bots/${bot.id}/routines/${routine.id}`, {
            body: { name: "Nightly" },
          })
        ).name,
      ).toBe("Nightly");
      // The right routine under the wrong bot is not found.
      expect(
        (
          await api(token, "PATCH", `/bots/${other.id}/routines/${routine.id}`, {
            body: { name: "Stolen" },
          })
        ).status,
      ).toBe(404);
      const run = await ok<{ runId: string }>(
        token,
        "POST",
        `/bots/${bot.id}/routines/${routine.id}/run`,
        { key: "run-1" },
      );
      const replay = await ok<{ runId: string }>(
        token,
        "POST",
        `/bots/${bot.id}/routines/${routine.id}/run`,
        { key: "run-1" },
      );
      expect(replay.runId).toBe(run.runId);
      const history = await ok<{ runs: Array<{ id: string }> }>(
        token,
        "GET",
        `/bots/${bot.id}/routines/${routine.id}/history`,
      );
      expect(history.runs.map((entry) => entry.id)).toContain(run.runId);
    });

    it("edits memory at a known revision and only under its own bot", async () => {
      const { cookie, actor } = await person();
      const bot = await newBot(cookie, "Remembers");
      const other = await newBot(cookie, "Forgets");
      const { token } = await newKey(cookie);
      const doc = await db.memoryDocument.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: bot.id,
          scope: "bot",
          path: "NOTES.md",
          content: "one",
          revision: 1,
        },
      } as never);
      const { documents } = await ok<{ documents: Array<{ id: string; content: string }> }>(
        token,
        "GET",
        `/bots/${bot.id}/memory`,
      );
      expect(documents.find((entry) => entry.id === (doc as { id: string }).id)?.content).toBe(
        "one",
      );
      const id = (doc as { id: string }).id;
      expect(
        (await api(token, "PUT", `/bots/${other.id}/memory/${id}`, { body: { content: "x" } }))
          .status,
      ).toBe(404);
      const written = await ok<{ content: string; revision: number }>(
        token,
        "PUT",
        `/bots/${bot.id}/memory/${id}`,
        { body: { content: "two", expectedRevision: 1 } },
      );
      expect(written).toMatchObject({ content: "two", revision: 2 });
      const stale = await api(token, "PUT", `/bots/${bot.id}/memory/${id}`, {
        body: { content: "three", expectedRevision: 1 },
      });
      expect(stale.status).toBe(409);
    });

    it("manages scratchpad items and tickets within a key's bots", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Tracked");
      const other = await newBot(cookie, "Untracked");
      const { token } = await newKey(cookie);
      const limited = await newKey(cookie, EVERY_SCOPE, [bot.id]);

      const item = await ok<{ id: string }>(token, "POST", `/bots/${bot.id}/scratchpad`, {
        body: { title: "note" },
        key: "note-1",
      });
      expect(
        (
          await ok<{ status: string }>(token, "PATCH", `/bots/${bot.id}/scratchpad/${item.id}`, {
            body: { status: "done" },
          })
        ).status,
      ).toBe("done");
      expect((await api(token, "DELETE", `/bots/${other.id}/scratchpad/${item.id}`)).status).toBe(
        404,
      );
      await ok(token, "DELETE", `/bots/${bot.id}/scratchpad/${item.id}`);

      const mine = await ok<{ id: string }>(token, "POST", "/tickets", {
        body: { title: "mine", assigneeBotId: bot.id },
        key: "ticket-1",
      });
      const theirs = await ok<{ id: string }>(token, "POST", "/tickets", {
        body: { title: "theirs", assigneeBotId: other.id },
        key: "ticket-2",
      });
      const seen = await ok<{ tickets: Array<{ id: string }> }>(limited.token, "GET", "/tickets");
      expect(seen.tickets.map((ticket) => ticket.id)).toEqual([mine.id]);
      expect((await api(limited.token, "GET", `/tickets/${theirs.id}`)).status).toBe(404);
      // Boards belong to the whole space, so a key limited to chosen bots cannot list them.
      expect((await api(limited.token, "GET", "/boards")).status).toBe(403);
      expect(
        (
          await api(limited.token, "POST", "/tickets", {
            body: { title: "x", assigneeBotId: other.id },
            key: "ticket-3",
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await api(limited.token, "PATCH", `/tickets/${mine.id}`, {
            body: { assigneeBotId: other.id },
          })
        ).status,
      ).toBe(404);
      const comment = await ok<{ body: string }>(
        limited.token,
        "POST",
        `/tickets/${mine.id}/comments`,
        { body: { body: "looks good" }, key: "comment-1" },
      );
      expect(comment.body).toBe("looks good");
    });

    it("reaches a group and marks what it sends", async () => {
      const { cookie } = await person();
      const first = await newBot(cookie, "One");
      const second = await newBot(cookie, "Two");
      const { token, credential } = await newKey(cookie);
      const group = await ok<{ id: string; threadId: string }>(token, "POST", "/groups", {
        body: { name: "Team", botIds: [first.id, second.id] },
        key: "group-1",
      });
      await ok(token, "POST", `/groups/${group.id}/prompts`, {
        body: { text: "hello team" },
        key: "group-prompt-1",
      });
      const page = await ok<{
        messages: Array<{ role: string; blocks: Array<{ kind: string; name?: string }> }>;
      }>(token, "GET", `/groups/${group.id}/activity`);
      const sent = page.messages.find((message) => message.role === "user");
      expect(sent?.blocks).toContainEqual({ kind: "sent_with_key", name: credential.name });
    });

    it("marks a key's message for the person and the bot, without letting the key forge it", async () => {
      const { cookie, actor } = await person();
      const bot = await newBot(cookie, "Told");
      const { token, credential } = await newKey(cookie);
      const sent = await ok<{ taskId: string }>(token, "POST", `/bots/${bot.id}/prompts`, {
        body: { text: "deploy it" },
        key: "marked",
      });
      const { threadId } = await rpc<{ threadId: string }>(cookie, "threads/head", {
        botId: bot.id,
      });
      const row = await db.message.findFirstOrThrow({
        where: { threadId, clientNonce: `service:${credential.id}:marked` },
      });
      expect(row.blocks).toEqual([
        { kind: "text", text: "deploy it" },
        { kind: "service_origin", credentialId: credential.id, name: credential.name },
      ]);
      const task = await db.task.findUniqueOrThrow({ where: { id: sent.taskId } });
      expect(task.prompt).toContain(`[sent with the API key "${credential.name}"`);
      expect(task.prompt).toContain("deploy it");

      // A person typing in the same chat carries no mark.
      await rpc(cookie, "threads/send", { botId: bot.id, text: "from me" });
      const typed = await db.message.findFirstOrThrow({
        where: { threadId, role: "user" },
        orderBy: { seq: "desc" },
      });
      expect(typed.blocks).toEqual([{ kind: "text", text: "from me" }]);

      // The field is not an input, on the RPC or on the API.
      const forged = await api(token, "POST", `/bots/${bot.id}/prompts`, {
        body: { text: "x", serviceOrigin: { credentialId: "a", name: "b" } },
        key: "forged",
      });
      expect(forged.status).toBe(400);
      void actor;
    });
  });

  describe("how far a key's message is trusted", () => {
    it("starts a run that is not the owner's", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Untrusted");
      const { token } = await newKey(cookie);
      const sent = await ok<{ runId: string }>(token, "POST", `/bots/${bot.id}/prompts`, {
        body: { text: "go" },
        key: "trust-1",
      });
      const run = await db.run.findUniqueOrThrow({ where: { id: sent.runId } });
      expect(run.trigger).toBe("service");
      expect(isOwnerStartedRun(run.trigger, true)).toBe(false);
    });

    it("waits for its own run rather than steering one under way", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Busy");
      const { token, credential } = await newKey(cookie);
      const threadId = await threadOf(cookie, bot.id);
      const first = await busyRun(threadId);
      const accepted = await ok<Record<string, unknown>>(token, "POST", `/bots/${bot.id}/prompts`, {
        body: { text: "from a key" },
        key: "held",
      });
      const message = await db.message.findFirstOrThrow({
        where: { threadId, clientNonce: `service:${credential.id}:held` },
      });
      expect(accepted).toMatchObject({
        runId: null,
        taskId: null,
        held: true,
        messageId: message.id,
      });
      const held = await db.steeringMessage.findFirstOrThrow({
        where: { messageId: message.id },
      });
      expect(held).toMatchObject({ runId: null, originTrigger: "service" });
      expect(message.runId).toBeNull();

      await db.run.update({ where: { id: first.runId }, data: { status: "completed" } });
      const continued = await db.$transaction((tx) =>
        createPendingSteeringRun(tx, { spaceId: bot.spaceId, threadId, botId: bot.id }),
      );
      const run = await db.run.findUniqueOrThrow({
        where: { id: continued! },
        include: { task: true },
      });
      expect(run.trigger).toBe("service");
      expect(run.task.prompt).toContain("from a key");
      expect(run.task.prompt).toContain(`[sent with the API key "${credential.name}"`);

      const retried = await ok<Record<string, unknown>>(token, "POST", `/bots/${bot.id}/prompts`, {
        body: { text: "from a key" },
        key: "held",
      });
      expect(retried).toMatchObject({ runId: run.id, taskId: run.taskId, held: false });
    });

    it("names the shared run for every message that waited", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Shared");
      const { token } = await newKey(cookie);
      const threadId = await threadOf(cookie, bot.id);
      const first = await busyRun(threadId);
      const send = (key: string, text: string) =>
        ok<{ runId: string | null; held: boolean; messageId: string }>(
          token,
          "POST",
          `/bots/${bot.id}/prompts`,
          { body: { text }, key },
        );
      const earlier = await send("one", "first waiting");
      const later = await send("two", "second waiting");
      expect([earlier.held, later.held]).toEqual([true, true]);

      await db.run.update({ where: { id: first.runId }, data: { status: "completed" } });
      await db.$transaction((tx) =>
        createPendingSteeringRun(tx, { spaceId: bot.spaceId, threadId, botId: bot.id }),
      );
      const shared = await db.run.findFirstOrThrow({ where: { sourceMessageId: later.messageId } });
      await expect(send("one", "first waiting")).resolves.toMatchObject({
        runId: shared.id,
        held: false,
      });
      await expect(send("two", "second waiting")).resolves.toMatchObject({
        runId: shared.id,
        held: false,
      });

      // Answered: the waiting rows are gone, and a retry must not read as a dropped message.
      await db.steeringMessage.deleteMany({ where: { runId: shared.id } });
      await db.run.update({ where: { id: shared.id }, data: { status: "completed" } });
      await expect(send("one", "first waiting")).resolves.toMatchObject({
        runId: shared.id,
        taskId: shared.taskId,
        held: false,
      });
      expect(await db.message.count({ where: { threadId, role: "user" } })).toBe(2);
    });

    it("says so when a stop dropped the waiting message", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Stopped");
      const { token } = await newKey(cookie);
      await busyRun(await threadOf(cookie, bot.id));
      const send = (wait = "") =>
        ok<Record<string, unknown>>(token, "POST", `/bots/${bot.id}/prompts${wait}`, {
          body: { text: "from a key" },
          key: "dropped",
        });
      await expect(send()).resolves.toMatchObject({ runId: null, held: true });
      await ok(token, "POST", `/bots/${bot.id}/stop`);

      const started = Date.now();
      const after = await send("?wait=30");
      expect(after).toMatchObject({ runId: null, taskId: null, held: false });
      expect(after).not.toHaveProperty("run");
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it("does not answer a question the bot is waiting on", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Asking");
      const { token } = await newKey(cookie);
      const threadId = await threadOf(cookie, bot.id);
      const first = await rpc<{ runId: string }>(cookie, "threads/send", {
        botId: bot.id,
        text: "start",
      });
      // The scripted runtime must be finished, or its worker could pick the run back up.
      await vi.waitFor(
        async () => {
          const { status } = await db.run.findUniqueOrThrow({ where: { id: first.runId } });
          expect(["completed", "failed", "cancelled"]).toContain(status);
        },
        { timeout: 10_000 },
      );
      await db.run.update({ where: { id: first.runId }, data: { status: "waiting_input" } });
      const ask = await db.message.create({
        data: {
          threadId,
          seq: 7000,
          role: "bot",
          botId: bot.id,
          runId: first.runId,
          blocks: [{ kind: "ask", text: "Approve?", status: "pending" }],
        },
      } as never);
      await ok(token, "POST", `/bots/${bot.id}/prompts`, {
        body: { text: "yes, approved" },
        key: "self-approve",
      });
      const after = await db.message.findUniqueOrThrow({
        where: { id: (ask as { id: string }).id },
      });
      expect(after.blocks).toEqual([{ kind: "ask", text: "Approve?", status: "pending" }]);
      expect((await db.run.findUniqueOrThrow({ where: { id: first.runId } })).status).toBe(
        "waiting_input",
      );
    });
  });

  describe("waiting for a reply", () => {
    it("returns what the bot said once the run settles", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Answering");
      const other = await newBot(cookie, "Elsewhere");
      const { token } = await newKey(cookie);
      const sent = await ok<{ runId: string; run: { settled: boolean; status: string } }>(
        token,
        "POST",
        `/bots/${bot.id}/prompts?wait=30`,
        { body: { text: "hello" }, key: "wait-1" },
      );
      expect(sent.run).toMatchObject({ settled: true, status: "completed" });
      const run = await ok<{
        runId: string;
        trigger: string;
        messages: Array<{ role: string; runId: string; blocks: Array<{ kind: string }> }>;
      }>(token, "GET", `/runs/${sent.runId}?wait=5`);
      expect(run).toMatchObject({ runId: sent.runId, trigger: "service", settled: true });
      expect(run.messages.length).toBeGreaterThan(0);
      for (const message of run.messages) {
        expect(message.role).not.toBe("user");
        expect(message.runId).toBe(sent.runId);
        for (const block of message.blocks)
          expect(["text", "ask", "file", "page"]).toContain(block.kind);
      }

      const elsewhere = await newKey(cookie, EVERY_SCOPE, [other.id]);
      expect((await api(elsewhere.token, "GET", `/runs/${sent.runId}`)).status).toBe(404);
      const stranger = await person();
      const theirs = await newKey(stranger.cookie);
      expect((await api(theirs.token, "GET", `/runs/${sent.runId}`)).status).toBe(404);
      expect((await api(token, "GET", `/runs/${sent.runId}?wait=61`)).status).toBe(400);
    });

    it("follows a waiting message into its own run, not the one under way", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Queued");
      const { token, credential } = await newKey(cookie);
      const threadId = await threadOf(cookie, bot.id);
      const first = await busyRun(threadId);
      const waiting = ok<{ runId: string; held: boolean; run: { runId: string } }>(
        token,
        "POST",
        `/bots/${bot.id}/prompts?wait=30`,
        { body: { text: "from a key" }, key: "own-run" },
      );
      const message = await vi.waitFor(
        async () => {
          const found = await db.message.findFirstOrThrow({
            where: { threadId, clientNonce: `service:${credential.id}:own-run` },
            include: { steeringMessages: true },
          });
          expect(found.steeringMessages).toHaveLength(1);
          return found;
        },
        { timeout: 10_000 },
      );

      await db.run.update({ where: { id: first.runId }, data: { status: "completed" } });
      await db.$transaction((tx) =>
        createPendingSteeringRun(tx, { spaceId: bot.spaceId, threadId, botId: bot.id }),
      );
      const own = await db.run.findFirstOrThrow({ where: { sourceMessageId: message.id } });
      const sent = await waiting;
      expect(own.id).not.toBe(first.runId);
      expect(sent).toMatchObject({ runId: own.id, held: false, run: { runId: own.id } });
    });

    it("reports a message still waiting when the time is up", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Long queue");
      const { token } = await newKey(cookie);
      await busyRun(await threadOf(cookie, bot.id));
      const sent = await ok<Record<string, unknown>>(
        token,
        "POST",
        `/bots/${bot.id}/prompts?wait=1`,
        { body: { text: "from a key" }, key: "out-of-time" },
      );
      expect(sent).toMatchObject({ runId: null, taskId: null, held: true });
      expect(sent).not.toHaveProperty("run");
    });

    it("gives up at the wait and says the run is not settled", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Slow");
      const { token } = await newKey(cookie);
      const sent = await ok<{ runId: string }>(token, "POST", `/bots/${bot.id}/prompts?wait=30`, {
        body: { text: "hello" },
        key: "slow-1",
      });
      await db.run.update({ where: { id: sent.runId }, data: { status: "running" } });
      const started = Date.now();
      const run = await ok<{ settled: boolean }>(token, "GET", `/runs/${sent.runId}?wait=1`);
      expect(run.settled).toBe(false);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      await db.run.update({ where: { id: sent.runId }, data: { status: "completed" } });
    });
  });

  describe("as tools for an agent", () => {
    let nextId = 0;
    const mcp = async (token: string | null, method: string, params?: unknown, notify = false) => {
      nextId += 1;
      const response = await app.request(`${SERVICE_API_PREFIX}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...(notify ? {} : { id: nextId }), method, params }),
      });
      const text = await response.text();
      return {
        status: response.status,
        json: (text ? JSON.parse(text) : null) as {
          id?: number;
          error?: { code: number | string };
          result?: {
            protocolVersion?: string;
            tools?: Array<{ name: string; inputSchema: { required: string[] } }>;
            isError?: boolean;
            content?: Array<{ text: string }>;
            structuredContent?: Record<string, unknown>;
          };
        },
      };
    };

    it("answers nobody without a live key", async () => {
      for (const method of ["initialize", "tools/list", "ping"]) {
        expect((await mcp(null, method)).status, method).toBe(401);
        expect((await mcp("not-a-key", method)).status, method).toBe(401);
      }
      const called = await mcp(null, "tools/call", { name: "listBots", arguments: {} });
      expect(called.status).toBe(401);
    });

    it("speaks the protocol", async () => {
      const { cookie } = await person();
      const { token } = await newKey(cookie);
      const started = await mcp(token, "initialize", { protocolVersion: "2025-03-26" });
      expect(started.json.result?.protocolVersion).toBe("2025-03-26");
      expect((await mcp(token, "notifications/initialized", undefined, true)).status).toBe(202);
      expect((await mcp(token, "ping")).json.result).toEqual({});
      expect((await mcp(token, "resources/list")).json.error?.code).toBe(-32601);
      const get = await app.request(`${SERVICE_API_PREFIX}/mcp`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(get.status).toBe(405);
      const oversized = await app.request(`${SERVICE_API_PREFIX}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "x".repeat(70_000),
      });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toEqual({
        error: { code: "payload_too_large", message: "Body too large for this call." },
      });
    });

    it("offers a key only the tools it may use", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Tooled");
      const every = await mcp((await newKey(cookie)).token, "tools/list");
      const names = (every.json.result?.tools ?? []).map((tool) => tool.name).sort();
      expect(names).toEqual(
        ROUTES.filter(([id, definition]) => !definition.stream && id !== "openapi")
          .map(([id]) => id)
          .sort(),
      );
      const reader = await mcp((await newKey(cookie, ["bots:read"])).token, "tools/list");
      expect((reader.json.result?.tools ?? []).map((tool) => tool.name).sort()).toEqual(
        ROUTES.filter(
          ([id, definition]) =>
            id !== "openapi" && (definition.scope === null || definition.scope === "bots:read"),
        )
          .map(([id]) => id)
          .sort(),
      );
      const limited = await mcp((await newKey(cookie, EVERY_SCOPE, [bot.id])).token, "tools/list");
      const offered = new Set((limited.json.result?.tools ?? []).map((tool) => tool.name));
      for (const [id, definition] of ROUTES) {
        if (definition.spaceWide) expect(offered.has(id), id).toBe(false);
      }
      expect(offered.has("sendPrompt")).toBe(true);
    });

    it("carries a tool call out as the request it stands for", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Called");
      const other = await newBot(cookie, "Unlisted");
      const { token, credential } = await newKey(cookie);
      const sent = await mcp(token, "tools/call", {
        name: "sendPrompt",
        arguments: {
          botId: bot.id,
          wait: 30,
          body: { text: "from a tool" },
          idempotencyKey: "mcp-1",
        },
      });
      const result = sent.json.result?.structuredContent as {
        runId: string;
        run: { settled: boolean };
      };
      expect(result.run.settled).toBe(true);
      expect(JSON.parse(sent.json.result?.content?.[0]?.text ?? "null")).toEqual(result);
      const run = await db.run.findUniqueOrThrow({ where: { id: result.runId } });
      expect(run.trigger).toBe("service");
      const again = await mcp(token, "tools/call", {
        name: "sendPrompt",
        arguments: { botId: bot.id, body: { text: "from a tool" }, idempotencyKey: "mcp-1" },
      });
      expect(again.json.result?.structuredContent).toMatchObject({ runId: result.runId });
      const audited = await db.auditEvent.findFirst({
        where: { action: "service_api.prompt", actorId: credential.id, runId: result.runId },
      });
      expect(audited).not.toBeNull();

      const reader = await newKey(cookie, ["bots:read"]);
      const refused = await mcp(reader.token, "tools/call", {
        name: "sendPrompt",
        arguments: { botId: bot.id, body: { text: "no" } },
      });
      expect(refused.json.result?.isError).toBe(true);
      expect(refused.json.result?.content?.[0]?.text).toContain("forbidden");
      const limited = await newKey(cookie, EVERY_SCOPE, [bot.id]);
      const offList = await mcp(limited.token, "tools/call", {
        name: "getBot",
        arguments: { botId: other.id },
      });
      expect(offList.json.result?.content?.[0]?.text).toContain("not_found");

      for (const [bad, reason] of [
        [{ botId: "../me", body: { text: "x" } }, 'Argument "botId" is missing or malformed.'],
        [{ botId: bot.id, body: { text: "x" }, extra: 1 }, 'Unknown argument "extra".'],
        [
          { botId: bot.id, body: { text: "x" }, idempotencyKey: 5 },
          'Argument "idempotencyKey" is missing or malformed.',
        ],
      ] as const) {
        const result = await mcp(token, "tools/call", { name: "sendPrompt", arguments: bad });
        expect(result.json.result?.isError, reason).toBe(true);
        expect(result.json.result?.content?.[0]?.text).toBe(reason);
      }
      expect((await mcp(token, "tools/call", { name: "botEvents" })).json.error?.code).toBe(-32602);
      expect((await mcp(token, "tools/call", { name: "nope" })).json.error?.code).toBe(-32602);
    });
  });

  it("shows a limited key only its bots' runs", async () => {
    const { cookie } = await person();
    const mine = await newBot(cookie, "Mine");
    const other = await newBot(cookie, "Other");
    const { token } = await newKey(cookie);
    const limited = await newKey(cookie, EVERY_SCOPE, [mine.id]);
    for (const bot of [mine, other]) {
      await ok(token, "POST", `/bots/${bot.id}/prompts`, {
        body: { text: "work" },
        key: `run-${bot.id}`,
      });
    }
    const { runs } = await ok<{ runs: Array<{ botId: string }> }>(limited.token, "GET", "/runs");
    expect(runs.map((run) => run.botId)).toEqual([mine.id]);
  });

  it("returns a bot through the allowlist, not as stored", async () => {
    const { cookie } = await person();
    const bot = await newBot(cookie, "Listed");
    const { token } = await newKey(cookie);
    const read = await ok<Record<string, unknown>>(token, "GET", `/bots/${bot.id}`);
    expect(read).toMatchObject({ id: bot.id, name: "Listed" });
    for (const hidden of ["spawnKey", "teamChatRules", "disabledBuiltinTools", "fleetManagement"]) {
      expect(read).not.toHaveProperty(hidden);
    }
  });

  describe("events", () => {
    const readUntil = async (
      response: Response,
      wanted: (buffer: string) => boolean,
    ): Promise<string> => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const deadline = Date.now() + 15_000;
      while (!wanted(buffer) && Date.now() < deadline) {
        const next = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: true, value: undefined }), 15_000),
          ),
        ]);
        if (next.done) break;
        buffer += decoder.decode(next.value);
      }
      await reader.cancel();
      return buffer;
    };
    const open = (token: string, botId: string, query = "") =>
      app.request(`${SERVICE_API_PREFIX}/bots/${botId}/events${query}`, {
        headers: { authorization: `Bearer ${token}` },
      });

    it("streams the conversation with the same allowlist", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Streamed");
      const { token } = await newKey(cookie);
      const response = await open(token, bot.id);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      answered.add("botEvents");
      await ok(token, "POST", `/bots/${bot.id}/prompts`, {
        body: { text: "stream me" },
        key: "stream-1",
      });
      const body = await readUntil(response, (buffer) => buffer.includes("stream me"));
      expect(body).toContain("event: thread.message.created");
      expect(body).toContain("stream me");
      expect(body).toContain('"kind":"sent_with_key"');
    });

    it("opens at once on a quiet bot", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Quiet");
      const { token } = await newKey(cookie);
      const reader = (await open(token, bot.id)).body!.getReader();
      const first = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no bytes")), 2_000)),
      ]);
      expect(new TextDecoder().decode(first.value)).toBe(": connected\n\n");
      await reader.cancel();
    });

    it("ends the stream soon after the key is revoked", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Revoked");
      const { token, credential } = await newKey(cookie);
      const response = await open(token, bot.id);
      await rpc(cookie, "serviceCredentials/revoke", { id: credential.id });
      const reader = response.body!.getReader();
      const closed = (async () => {
        for (;;) {
          if ((await reader.read()).done) return true;
        }
      })();
      expect(
        await Promise.race([
          closed,
          new Promise((resolve) => setTimeout(() => resolve(false), 40_000)),
        ]),
      ).toBe(true);
    }, 45_000);

    it("limits how many streams one key may hold", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Popular");
      const { token } = await newKey(cookie);
      const held = await Promise.all(Array.from({ length: 5 }, () => open(token, bot.id)));
      expect(held.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
      const refused = await open(token, bot.id);
      expect(refused.status).toBe(429);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
        "too_many_streams",
      );
      await Promise.all(held.map((response) => response.body?.cancel()));
      await expect
        .poll(async () => {
          const again = await open(token, bot.id);
          await again.body?.cancel();
          return again.status;
        })
        .toBe(200);
    });
  });

  it("answers with a valid body on the routes the other tests do not exercise", async () => {
    const { cookie } = await person();
    const bot = await newBot(cookie, "Everything");
    const peer = await newBot(cookie, "Peer");
    const { token } = await newKey(cookie);
    const under = `/bots/${bot.id}`;

    await ok(token, "GET", `${under}/status`);
    await ok(token, "POST", `${under}/stop`);
    await ok(token, "GET", "/runs?filter=recent");
    expect(await ok(token, "GET", `${under}/computer`)).toMatchObject({ botId: bot.id });
    await ok(token, "POST", `${under}/computer/boot`);
    await ok(token, "POST", `${under}/computer/stop`);
    const artifact = await rpc<{ id: string }>(cookie, "artifacts/create", {
      botId: bot.id,
      name: "note.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("hello").toString("base64"),
    });
    const artifacts = await ok<{ artifacts: Array<{ id: string }> }>(
      token,
      "GET",
      `${under}/artifacts`,
    );
    expect(artifacts.artifacts.map((entry) => entry.id)).toContain(artifact.id);
    expect(await ok(token, "GET", `${under}/artifacts/${artifact.id}`)).toMatchObject({
      contentBase64: Buffer.from("hello").toString("base64"),
    });
    await ok(token, "GET", `${under}/scratchpad`);
    await ok(token, "GET", `${under}/skills`);
    await ok(token, "GET", `${under}/pages`);

    const group = await ok<{ id: string }>(token, "POST", "/groups", {
      body: { name: "Crew", botIds: [bot.id, peer.id] },
      key: "crew",
    });
    await ok(token, "GET", "/groups");
    await ok(token, "GET", `/groups/${group.id}`);
    await ok(token, "PATCH", `/groups/${group.id}`, { body: { name: "Crew 2" } });
    await ok(token, "POST", `/groups/${group.id}/stop`);
    await ok(token, "POST", `/groups/${group.id}/archive`);

    await ok(token, "GET", "/boards");
    const ticket = await ok<{ id: string }>(token, "POST", "/tickets", {
      body: { title: "read me", assigneeBotId: bot.id },
      key: "readable",
    });
    await ok(token, "GET", `/tickets/${ticket.id}`);
    expect(
      await ok(token, "PATCH", `/tickets/${ticket.id}`, { body: { title: "read me twice" } }),
    ).toMatchObject({ title: "read me twice" });
    await ok(token, "GET", `/tickets/${ticket.id}/comments`);
    await ok(token, "GET", "/usage/summary");
    await ok(token, "GET", "/search?q=Everything");
    await ok(token, "GET", "/audit/events?limit=5");
  });

  it("answers an out-of-range cursor and a NUL without a server error", async () => {
    const { cookie } = await person();
    const bot = await newBot(cookie, "Edges");
    const { token } = await newKey(cookie);
    const huge = await api(token, "GET", `/bots/${bot.id}/activity?before=999999999999999`);
    expect(huge.status).toBe(200);
    for (const suffix of ["/search?q=%00", "/audit/events?action=a%00b", "/tickets?q=%00"]) {
      expect((await api(token, "GET", suffix)).status, suffix).toBe(400);
    }
  });

  it("describes itself from the table the server enforces", async () => {
    const { cookie } = await person();
    const { token } = await newKey(cookie, ["bots:read"]);
    const document = await ok<{
      openapi: string;
      paths: Record<
        string,
        Record<
          string,
          {
            "x-required-scope": string | null;
            parameters?: { name: string; schema: { pattern?: string } }[];
          }
        >
      >;
    }>(token, "GET", "/openapi.json");
    expect(document.openapi).toBe("3.1.0");
    const waitParameter = document.paths["/bots/{botId}/prompts"]?.post?.parameters?.find(
      (parameter) => parameter.name === "wait",
    );
    const published = new RegExp(waitParameter?.schema.pattern ?? "(?!)");
    expect(["0", "60", "61", "99"].map((value) => published.test(value))).toEqual([
      true,
      true,
      false,
      false,
    ]);
    for (const [id, definition] of ROUTES) {
      const path = definition.path.replace(/:([A-Za-z]+)/g, "{$1}");
      expect([
        id,
        document.paths[path]?.[definition.method.toLowerCase()]?.["x-required-scope"],
      ]).toEqual([id, definition.scope]);
    }
  });

  it("names the key and what it may do", async () => {
    const { cookie, actor } = await person();
    const { token, credential } = await newKey(cookie, ["bots:read", "memory:read"]);
    expect(await ok(token, "GET", "/me")).toEqual({
      id: credential.id,
      name: credential.name,
      spaceId: actor.spaceId,
      scopes: ["bots:read", "memory:read"],
      botIds: [],
      expiresAt: credential.expiresAt,
    });
  });

  it("writes every change to the audit log against the key", async () => {
    const { cookie, actor } = await person();
    const bot = await newBot(cookie, "Watched");
    const { token, credential } = await newKey(cookie);
    await ok(token, "PATCH", `/bots/${bot.id}`, { body: { name: "Seen" } });
    await ok(token, "GET", `/bots/${bot.id}`);
    const events = await db.auditEvent.findMany({ where: { actorId: credential.id } });
    expect(events.map((event) => event.action)).toEqual(["service_api.updateBot"]);
    expect(events[0]).toMatchObject({
      actorType: "service",
      spaceId: actor.spaceId,
      targetId: bot.id,
    });
    expect(events[0]?.metadata).toMatchObject({ onBehalfOf: actor.userId });
  });

  it("has seen every route succeed", () => {
    expect(ROUTES.map(([id]) => id).filter((id) => !answered.has(id))).toEqual([]);
  });
});
