import type { ServiceScope } from "@rakazo/contracts";
import { readScopeOf, SERVICE_API_PREFIX } from "@rakazo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import type { ServiceApiHarness } from "./service-api-harness.test-support.js";
import {
  describeWithDatabase,
  EVERY_SCOPE,
  ROUTES,
  serviceApiHarness,
} from "./service-api-harness.test-support.js";

describeWithDatabase("service API surface", () => {
  const harness = serviceApiHarness();
  const { answered, api, busyRun, concrete, newBot, newKey, ok, person, rpc, threadOf } = harness;
  let app: ServiceApiHarness["app"];
  let db: ServiceApiHarness["db"];
  beforeAll(() => {
    app = harness.app;
    db = harness.db;
  });

  it("shows a bot's status and its run list with only the creator's runs", async () => {
    const { cookie } = await person();
    const bot = await newBot(cookie, "Shared");
    const { token } = await newKey(cookie, ["bots:read", "conversations:read"]);
    const own = await busyRun(bot.threadId);
    const thread = await db.thread.findUniqueOrThrow({ where: { id: bot.threadId } });
    const { actor: someoneElse } = await person();
    const task = await db.task.create({
      data: {
        spaceId: thread.spaceId,
        userId: someoneElse.userId,
        botId: bot.id,
        threadId: bot.threadId,
        prompt: "another member's work",
        status: "running",
      },
    });
    const theirs = await db.run.create({
      data: {
        spaceId: thread.spaceId,
        userId: someoneElse.userId,
        botId: bot.id,
        threadId: bot.threadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
      },
    });
    const status = await ok<{ runs: Array<{ id: string }> }>(
      token,
      "GET",
      `/bots/${bot.id}/status`,
    );
    expect(status.runs.map((run) => run.id)).toEqual([own.runId]);
    // The run list leaves the other member's run out too.
    const listed = await ok<{ runs: Array<{ runId: string }> }>(token, "GET", "/runs");
    expect(listed.runs.map((run) => run.runId)).toContain(own.runId);
    expect(listed.runs.map((run) => run.runId)).not.toContain(theirs.id);
    // Recent keeps one run per chat. Another member's later run must not hide the creator's.
    await db.run.update({
      where: { id: own.runId },
      data: { status: "completed", completedAt: new Date(Date.now() - 1000) },
    });
    await db.run.update({
      where: { id: theirs.id },
      data: { status: "completed", completedAt: new Date() },
    });
    const recent = await ok<{ runs: Array<{ runId: string }> }>(
      token,
      "GET",
      "/runs?filter=recent",
    );
    expect(recent.runs.map((run) => run.runId)).toContain(own.runId);
    expect(recent.runs.map((run) => run.runId)).not.toContain(theirs.id);
  });

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
        // A write scope carries its area's read scope, so leave out both.
        const others = EVERY_SCOPE.filter(
          (scope) => scope !== definition.scope && readScopeOf(scope) !== definition.scope,
        );
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

    it("refuses one key for a prompt to a different bot", async () => {
      const { cookie } = await person();
      const { token } = await newKey(cookie);
      const first = await newBot(cookie, "First");
      const second = await newBot(cookie, "Second");
      const body = { text: "only once" };
      await ok(token, "POST", `/bots/${first.id}/prompts`, { body, key: "one-key" });
      const again = await api(token, "POST", `/bots/${first.id}/prompts`, { body, key: "one-key" });
      expect(again.status).toBe(200);
      const elsewhere = await api(token, "POST", `/bots/${second.id}/prompts`, {
        body,
        key: "one-key",
      });
      expect([elsewhere.status, elsewhere.json.error?.code]).toEqual([409, "idempotency_conflict"]);
      const secondThread = await threadOf(cookie, second.id);
      expect(await db.message.count({ where: { threadId: secondThread, role: "user" } })).toBe(0);
      // A refused prompt frees its key, as a refused stored write does.
      const refused = await api(token, "POST", `/bots/absent/prompts`, {
        body,
        key: "free-prompt",
      });
      expect(refused.status).toBe(404);
      expect(await db.serviceIdempotencyKey.count({ where: { key: "free-prompt" } })).toBe(0);
    });

    it("replays a finished write after its bot is archived", async () => {
      const { cookie } = await person();
      const { token } = await newKey(cookie);
      const bot = await newBot(cookie, "Archived later");
      const body = { title: "remember this" };
      const path = `/bots/${bot.id}/scratchpad`;
      const first = await ok<{ id: string }>(token, "POST", path, { body, key: "before-archive" });
      await ok(token, "POST", `/bots/${bot.id}/archive`);
      const retry = await api<{ id: string }>(token, "POST", path, { body, key: "before-archive" });
      expect(retry.status).toBe(200);
      expect(retry.json.id).toBe(first.id);
      expect(retry.headers.get("idempotent-replayed")).toBe("true");
      const fresh = await api(token, "POST", path, { body, key: "after-archive" });
      expect(fresh.status).toBe(404);
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
      // A cursor that is valid JSON of the wrong shape is a bad request, not a server error.
      for (const cursor of [{}, { id: "x", createdAt: "not a date" }, null, "text"]) {
        const after = Buffer.from(JSON.stringify(cursor)).toString("base64url");
        const result = await api(
          token,
          "GET",
          `/bots/${bot.id}/routines/${routine.id}/history?after=${after}`,
        );
        expect([cursor, result.status, result.json.error?.code]).toEqual([
          cursor,
          400,
          "invalid_request",
        ]);
      }
    });

    it("marks a routine prompt a key wrote until the person writes their own", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Marked");
      const { credential, token } = await newKey(cookie);
      const path = `/bots/${bot.id}/routines`;
      const routine = await ok<{ id: string }>(token, "POST", path, {
        body: { name: "Daily", prompt: "Check https://example.com", crons: ["0 9 * * *"] },
        key: "marked-routine",
      });
      const mark = async () =>
        (await db.routine.findUniqueOrThrow({ where: { id: routine.id } })).promptCredentialId;
      const runMark = async (runId: string) =>
        (await db.run.findUniqueOrThrow({ where: { id: runId } })).promptCredentialId;
      expect(await mark()).toBe(credential.id);
      // A rename leaves the prompt, and so its author, alone.
      await ok(token, "PATCH", `${path}/${routine.id}`, { body: { name: "Renamed" } });
      expect(await mark()).toBe(credential.id);
      const keyRun = await ok<{ runId: string }>(token, "POST", `${path}/${routine.id}/run`, {
        key: "marked-run",
      });
      expect(await runMark(keyRun.runId)).toBe(credential.id);

      await rpc(cookie, "routines/update", { routineId: routine.id, prompt: "My own words" });
      expect(await mark()).toBeNull();
      const ownRun = await rpc<{ runId: string }>(cookie, "routines/testRun", {
        routineId: routine.id,
      });
      expect(await runMark(ownRun.runId)).toBeNull();
      // The earlier run keeps the author of the prompt it was started with.
      expect(await runMark(keyRun.runId)).toBe(credential.id);

      await ok(token, "PATCH", `${path}/${routine.id}`, { body: { prompt: "Key words again" } });
      expect(await mark()).toBe(credential.id);
    });

    it("keeps a key's mark on the run an inbound event starts from a routine it edited", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Hooked");
      const { credential, token } = await newKey(cookie);
      const routine = await rpc<{ id: string }>(cookie, "routines/create", {
        botId: bot.id,
        name: "On push",
        prompt: "My own words",
        crons: [],
        active: true,
        webhookEnabled: true,
      });
      const hook = await rpc<{ secret: string; path: string }>(cookie, "bots/rotateWebhookSecret", {
        botId: bot.id,
      });
      const deliver = async (key: string) => {
        const response = await app.request(hook.path, {
          method: "POST",
          headers: {
            authorization: `Bearer ${hook.secret}`,
            "content-type": "application/json",
            "idempotency-key": key,
          },
          body: JSON.stringify({ event: key }),
        });
        expect(response.status).toBe(200);
        const { runId } = (await response.json()) as { runId: string };
        return db.run.findUniqueOrThrow({ where: { id: runId } });
      };

      const idle = () =>
        db.run.updateMany({ where: { botId: bot.id }, data: { status: "cancelled" } });
      // The person's own routine starts an unmarked run.
      await idle();
      expect(await deliver("own")).toMatchObject({ trigger: "webhook", promptCredentialId: null });

      await ok(token, "PATCH", `/bots/${bot.id}/routines/${routine.id}`, {
        body: { prompt: "Message the other space" },
      });
      await idle();
      expect(await deliver("edited")).toMatchObject({
        trigger: "webhook",
        promptCredentialId: credential.id,
      });

      // An event that has to wait keeps the mark for the run it starts later.
      const waiting = await app.request(hook.path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${hook.secret}`,
          "content-type": "application/json",
          "idempotency-key": "waiting",
        },
        body: JSON.stringify({ event: "waiting" }),
      });
      const { messageId } = (await waiting.json()) as { messageId: string };
      expect(await db.steeringMessage.findFirstOrThrow({ where: { messageId } })).toMatchObject({
        runId: null,
        originTrigger: "webhook",
        promptCredentialId: credential.id,
      });
    });

    it("marks the run a key's prompt starts", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Prompted");
      const { credential, token } = await newKey(cookie);
      const sent = await ok<{ runId: string }>(token, "POST", `/bots/${bot.id}/prompts`, {
        body: { text: "remind me tomorrow" },
        key: "marked-prompt",
      });
      expect(await db.run.findUniqueOrThrow({ where: { id: sent.runId } })).toMatchObject({
        trigger: "service",
        promptCredentialId: credential.id,
      });
      // The person's own message starts an unmarked run.
      await db.run.updateMany({ where: { botId: bot.id }, data: { status: "cancelled" } });
      const own = await rpc<{ runId: string }>(cookie, "threads/send", {
        botId: bot.id,
        text: "from me",
      });
      expect(
        (await db.run.findUniqueOrThrow({ where: { id: own.runId } })).promptCredentialId,
      ).toBeNull();
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
        (
          await api(token, "PUT", `/bots/${other.id}/memory/${id}`, {
            body: { content: "x" },
            key: "memory-other",
          })
        ).status,
      ).toBe(404);
      const write = (content: string, key: string, expectedRevision?: number) =>
        api(token, "PUT", `/bots/${bot.id}/memory/${id}`, {
          body: { content, ...(expectedRevision ? { expectedRevision } : {}) },
          key,
        });
      const written = await write("two", "memory-two", 1);
      expect(written.json).toMatchObject({ content: "two", revision: 2 });
      const stale = await write("three", "memory-three", 1);
      expect(stale.status).toBe(409);
      // A replace needs a key, so a retry after a lost answer replays it rather than writing again.
      expect(
        (await api(token, "PUT", `/bots/${bot.id}/memory/${id}`, { body: { content: "x" } }))
          .status,
      ).toBe(400);
      const blind = await write("four", "memory-four");
      expect(blind.json).toMatchObject({ content: "four", revision: 3 });
      await write("newer edit", "memory-newer");
      const retry = await write("four", "memory-four");
      expect(retry.json).toMatchObject({ content: "four", revision: 3 });
      const after = await ok<{
        documents: Array<{ id: string; content: string; revision: number }>;
      }>(token, "GET", `/bots/${bot.id}/memory`);
      expect(after.documents.find((entry) => entry.id === id)).toMatchObject({
        content: "newer edit",
        revision: 4,
      });
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

    it("marks the run a ticket wakes when a key assigned it", async () => {
      const { cookie } = await person();
      const first = await newBot(cookie, "First");
      const second = await newBot(cookie, "Second");
      const { token, credential } = await newKey(cookie);
      const ticket = await ok<{ id: string }>(token, "POST", "/tickets", {
        body: { title: "Do the thing", assigneeBotId: first.id },
        key: "ticket-wake-1",
      });
      await ok(token, "PATCH", `/tickets/${ticket.id}`, { body: { assigneeBotId: second.id } });
      const wakes = await db.run.findMany({
        where: { botId: { in: [first.id, second.id] }, trigger: "tickets" },
        select: { botId: true, promptCredentialId: true },
      });
      expect(wakes).toHaveLength(2);
      expect(wakes.map((run) => run.promptCredentialId)).toEqual([credential.id, credential.id]);
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

    it("keeps group runs from a key limited to some bots", async () => {
      const { cookie, actor } = await person();
      const first = await newBot(cookie, "Member");
      const second = await newBot(cookie, "Peer");
      const { token } = await newKey(cookie);
      const limited = await newKey(cookie, ["conversations:read"], [first.id]);
      const group = await ok<{ id: string; threadId: string }>(token, "POST", "/groups", {
        body: { name: "Limited team", botIds: [first.id, second.id] },
        key: "limited-group",
      });
      const owner = { spaceId: actor.spaceId, userId: actor.userId, threadId: group.threadId };
      const task = await db.task.create({
        data: { ...owner, botId: first.id, prompt: "group work", status: "running" },
      });
      const run = await db.run.create({
        data: { ...owner, botId: first.id, taskId: task.id, status: "running", trigger: "user" },
      });

      const everyone = await ok<{ runs: Array<{ runId: string }> }>(token, "GET", "/runs");
      expect(everyone.runs.map((entry) => entry.runId)).toContain(run.id);
      await ok(token, "GET", `/runs/${run.id}`);

      const seen = await ok<{ runs: Array<{ runId: string }> }>(limited.token, "GET", "/runs");
      expect(seen.runs.map((entry) => entry.runId)).not.toContain(run.id);
      expect((await api(limited.token, "GET", `/runs/${run.id}`)).status).toBe(404);
    });

    it("holds a group message for a busy member instead of joining its run", async () => {
      const { cookie, actor } = await person();
      const first = await newBot(cookie, "Busy");
      const second = await newBot(cookie, "Free");
      const { token } = await newKey(cookie);
      const group = await ok<{ id: string; threadId: string }>(token, "POST", "/groups", {
        body: { name: "Busy team", botIds: [first.id, second.id] },
        key: "busy-group",
      });
      const owner = { spaceId: actor.spaceId, userId: actor.userId, threadId: group.threadId };
      const task = await db.task.create({
        data: { ...owner, botId: first.id, prompt: "the owner's work", status: "running" },
      });
      const busy = await db.run.create({
        data: { ...owner, botId: first.id, taskId: task.id, status: "running", trigger: "user" },
      });
      const sent = await ok<{ messageId: string; runId: string | null }>(
        token,
        "POST",
        `/groups/${group.id}/prompts`,
        { body: { text: "for whoever is free" }, key: "busy-group-prompt" },
      );
      expect(sent.runId).not.toBe(busy.id);
      const message = await db.message.findUniqueOrThrow({ where: { id: sent.messageId } });
      expect(message.runId).not.toBe(busy.id);
      expect(
        await db.steeringMessage.count({
          where: { messageId: sent.messageId, botId: first.id, runId: null },
        }),
      ).toBe(1);
    });

    it("holds a group message when every member is busy, and says so", async () => {
      const { cookie, actor } = await person();
      const first = await newBot(cookie, "Busy one");
      const second = await newBot(cookie, "Busy two");
      const { token } = await newKey(cookie);
      const group = await ok<{ id: string; threadId: string }>(token, "POST", "/groups", {
        body: { name: "All busy", botIds: [first.id, second.id] },
        key: "all-busy-group",
      });
      const owner = { spaceId: actor.spaceId, userId: actor.userId, threadId: group.threadId };
      for (const bot of [first, second]) {
        const task = await db.task.create({
          data: { ...owner, botId: bot.id, prompt: "the owner's work", status: "running" },
        });
        await db.run.create({
          data: { ...owner, botId: bot.id, taskId: task.id, status: "running", trigger: "user" },
        });
      }
      const send = () =>
        ok<{ messageId: string; runId: string | null; held: boolean }>(
          token,
          "POST",
          `/groups/${group.id}/prompts`,
          { body: { text: "when you are free" }, key: "all-busy-prompt" },
        );
      const sent = await send();
      expect(sent).toMatchObject({ runId: null, held: true });
      expect(
        await db.steeringMessage.count({ where: { messageId: sent.messageId, runId: null } }),
      ).toBe(2);
      // A retry finds the held message rather than saving it again.
      expect((await send()).messageId).toBe(sent.messageId);
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
        body: "x".repeat(1_300_000),
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

      // A body as large as the route accepts goes through the tool too.
      const owner = await db.bot.findUniqueOrThrow({ where: { id: bot.id } });
      const doc = (await db.memoryDocument.create({
        data: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          botId: bot.id,
          scope: "bot",
          path: "LARGE.md",
          content: "small",
          revision: 1,
        },
      } as never)) as { id: string };
      const large = "m".repeat(200_000);
      const memory = await mcp(token, "tools/call", {
        name: "updateMemory",
        arguments: { botId: bot.id, documentId: doc.id, body: { content: large } },
      });
      expect(memory.status).toBe(200);
      expect(memory.json.result?.isError, memory.json.result?.content?.[0]?.text).not.toBe(true);

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

    it("ends the stream when the account is deactivated, even if its keys were not revoked", async () => {
      const { cookie, actor } = await person();
      const bot = await newBot(cookie, "Deactivated");
      const { token } = await newKey(cookie);
      const response = await open(token, bot.id);
      // Only the flag, as if the step that revokes the account's keys had failed.
      await db.user.update({ where: { id: actor.userId }, data: { deactivatedAt: new Date() } });
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

    it("counts streams another server holds, until their lease lapses", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Shared");
      const { token, credential } = await newKey(cookie);
      const owner = await db.serviceCredential.findUniqueOrThrow({ where: { id: credential.id } });
      await db.serviceEventStream.createMany({
        data: Array.from({ length: 5 }, () => ({
          userId: owner.userId,
          spaceId: owner.spaceId,
          credentialId: credential.id,
          expiresAt: new Date(Date.now() + 60_000),
        })),
      });
      const refused = await open(token, bot.id);
      expect(refused.status).toBe(429);
      await db.serviceEventStream.updateMany({
        where: { credentialId: credential.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const lapsed = await open(token, bot.id);
      expect(lapsed.status).toBe(200);
      expect(await db.serviceEventStream.count({ where: { credentialId: credential.id } })).toBe(1);
      await lapsed.body?.cancel();
      await expect
        .poll(() => db.serviceEventStream.count({ where: { credentialId: credential.id } }))
        .toBe(0);
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
    // A group's bot count is published as the app enforces it.
    const groupBody = JSON.stringify(document.paths["/groups"]?.post);
    expect(groupBody).toContain('"minItems":2');
    expect(groupBody).toContain('"maxItems":10');
    for (const [id, definition] of ROUTES) {
      const path = definition.path.replace(/:([A-Za-z]+)/g, "{$1}");
      expect([
        id,
        document.paths[path]?.[definition.method.toLowerCase()]?.["x-required-scope"],
      ]).toEqual([id, definition.scope]);
    }
  });

  it("gives a write scope the read scope of its area, so writing reads nothing new", async () => {
    const { cookie } = await person();
    const { credential, token } = await newKey(cookie, ["bots:write", "prompts:write"]);
    expect(credential.scopes).toEqual(["bots:read", "bots:write", "prompts:write"]);
    expect((await ok<{ scopes: string[] }>(token, "GET", "/me")).scopes).toEqual([
      "bots:read",
      "bots:write",
      "prompts:write",
    ]);
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

    // A write outside a bot names the group or ticket, and what it created.
    const peer = await newBot(cookie, "Peer");
    const group = await ok<{ id: string }>(token, "POST", "/groups", {
      body: { name: "Crew", botIds: [bot.id, peer.id] },
      key: "audited-group",
    });
    await ok(token, "POST", `/groups/${group.id}/archive`);
    const ticket = await ok<{ id: string }>(token, "POST", "/tickets", {
      body: { title: "audited", assigneeBotId: bot.id },
      key: "audited-ticket",
    });
    const comment = await ok<{ id: string }>(token, "POST", `/tickets/${ticket.id}/comments`, {
      body: { body: "noted" },
      key: "audited-comment",
    });
    const later = await db.auditEvent.findMany({
      where: { actorId: credential.id, action: { not: "service_api.updateBot" } },
      orderBy: { createdAt: "asc" },
    });
    expect(later.map((event) => [event.action, event.targetType, event.targetId])).toEqual([
      ["service_api.createGroup", "group", group.id],
      ["service_api.archiveGroup", "group", group.id],
      ["service_api.createTicket", "ticket", ticket.id],
      ["service_api.addTicketComment", "ticket", ticket.id],
    ]);
    expect(later[3]?.metadata).toMatchObject({ ticketId: ticket.id, createdId: comment.id });
  });

  it("has seen every route succeed", () => {
    expect(ROUTES.map(([id]) => id).filter((id) => !answered.has(id))).toEqual([]);
  });
});
