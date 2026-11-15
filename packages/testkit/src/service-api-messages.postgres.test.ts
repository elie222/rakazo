import { isOwnerStartedRun } from "@rakazo/core";
import { createPendingSteeringRun } from "@rakazo/db";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ServiceApiHarness } from "./service-api-harness.test-support.js";
import {
  describeWithDatabase,
  EVERY_SCOPE,
  serviceApiHarness,
} from "./service-api-harness.test-support.js";

describeWithDatabase("service API messages", () => {
  const harness = serviceApiHarness();
  const { api, busyRun, newBot, newKey, ok, person, rpc, threadOf } = harness;
  let db: ServiceApiHarness["db"];
  beforeAll(() => {
    db = harness.db;
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

    it("does not wait for a reply for a key that may not read conversations", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Write only");
      const { token } = await newKey(cookie, ["bots:read", "prompts:write"]);
      const refused = await api(token, "POST", `/bots/${bot.id}/prompts?wait=5`, {
        body: { text: "tell me" },
        key: "write-only-wait",
      });
      expect(refused.status).toBe(403);
      expect(refused.json.error?.code).toBe("forbidden");
      // Refused before the send, so the bot never got the message.
      const threadId = await threadOf(cookie, bot.id);
      expect(await db.message.count({ where: { threadId, role: "user" } })).toBe(0);
      const sent = await ok<Record<string, unknown>>(token, "POST", `/bots/${bot.id}/prompts`, {
        body: { text: "tell me" },
        key: "write-only",
      });
      expect(sent).not.toHaveProperty("run");
    });

    it("counts a waiting call against the key's stream slots", async () => {
      const { cookie } = await person();
      const bot = await newBot(cookie, "Patient");
      const { token, credential } = await newKey(cookie);
      const sent = await ok<{ runId: string }>(token, "POST", `/bots/${bot.id}/prompts`, {
        body: { text: "hello" },
        key: "slots-1",
      });
      const owner = await db.serviceCredential.findUniqueOrThrow({ where: { id: credential.id } });
      await db.serviceEventStream.createMany({
        data: Array.from({ length: 5 }, () => ({
          userId: owner.userId,
          spaceId: owner.spaceId,
          credentialId: credential.id,
          expiresAt: new Date(Date.now() + 60_000),
        })),
      });
      const waiting = await api(token, "GET", `/runs/${sent.runId}?wait=1`);
      expect(waiting.status).toBe(429);
      expect(waiting.json.error?.code).toBe("too_many_streams");
      const sending = await api(token, "POST", `/bots/${bot.id}/prompts?wait=1`, {
        body: { text: "again" },
        key: "slots-2",
      });
      expect(sending.status).toBe(429);
      // A read that does not wait needs no slot.
      expect((await api(token, "GET", `/runs/${sent.runId}`)).status).toBe(200);
      await db.serviceEventStream.deleteMany({ where: { credentialId: credential.id } });
      await ok(token, "GET", `/runs/${sent.runId}?wait=1`);
      // The wait gives its slot back when it returns.
      expect(await db.serviceEventStream.count({ where: { credentialId: credential.id } })).toBe(0);
      const texts = await db.message.findMany({
        where: { threadId: await threadOf(cookie, bot.id), role: "user" },
        select: { blocks: true },
      });
      expect(JSON.stringify(texts)).not.toContain("again");
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
});
