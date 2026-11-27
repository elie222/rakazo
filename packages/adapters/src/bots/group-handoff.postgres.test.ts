import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import {
  asSystem,
  createDb,
  createGroupRepos,
  createRepos,
  createThreadEvents,
  createThreadMessage,
  provisionMessagingIdentity,
  runAsTenant,
  setBotPrimaryRuntimePreference,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "../runs/executor/executor.js";
import { pilotRuntimeForBot } from "../runs/turn/primary-runtime-pilot.js";
import { handoffToGroupBot } from "./group-handoff.js";

const url = process.env.DATABASE_URL;

describe.skipIf(!url || process.env.VERIFY_DATABASE !== "1" || process.platform !== "linux")(
  "per-bot group handoff admission (PostgreSQL)",
  () => {
    const { prisma, pool } = createDb(url!);
    const sys = asSystem(prisma);
    const address = `handoff-runtime-${randomUUID()}`;
    let actor: Actor;
    let senderId: string;
    let recipientId: string;
    let recipientKey: string;
    let threadId: string;
    let groupId: string;

    beforeAll(async () => {
      const { spaceId, userId } = await provisionMessagingIdentity(sys, {
        provider: "test",
        address,
      });
      actor = { userId, spaceId, email: "handoff-fixture@example.com", isDeploymentOwner: false };
      const createBot = (name: string) =>
        runAsTenant(actor, () =>
          createRepos(prisma).createBot(actor, {
            name,
            description: "",
            instructions: "",
            notifyOnFinish: true,
          }),
        );
      senderId = (await createBot("Coordinator")).id;
      recipientId = (await createBot("Reviewer")).id;
      for (const [id, label] of [
        [senderId, "sender"],
        [recipientId, "recipient"],
      ] as const) {
        const credential = await sys.userModelCredential.create({
          data: { userId, provider: "anthropic", label, secretId: randomUUID() },
        });
        await sys.bot.update({
          where: { id },
          data: {
            modelProvider: "anthropic",
            modelId: "claude-sonnet-4-6",
            modelCredentialId: credential.id,
          },
        });
        if (id === recipientId) recipientKey = credential.id;
      }
      const group = await runAsTenant(actor, () =>
        createGroupRepos(prisma).createGroup(actor, {
          name: "Handoff review",
          botIds: [senderId, recipientId],
        }),
      );
      groupId = group.id;
      threadId = group.threadId!;
    });

    afterEach(() => vi.unstubAllEnvs());
    afterAll(async () => {
      try {
        if (actor) {
          await sys.messagingIdentity.deleteMany({ where: { provider: "test", address } });
          await sys.organization.deleteMany({ where: { id: actor.spaceId } });
          await sys.user.deleteMany({ where: { id: actor.userId } });
        }
      } finally {
        await prisma.$disconnect();
        await pool.end();
      }
    });

    const profile = (botId: string) => sys.bot.findUniqueOrThrow({ where: { id: botId } });
    const choose = async (botId: string, preference: string) =>
      runAsTenant(actor, async () =>
        setBotPrimaryRuntimePreference(prisma, {
          ...actor,
          botId,
          preference,
          expectedRevision: (await profile(botId)).primaryRuntimeRevision,
        }),
      );

    const deps = {
      prisma,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    };
    async function startNativeHandoff() {
      const ids = `${senderId},${recipientId}`;
      vi.stubEnv("PRIMARY_RUNTIME_PILOT_BOT_IDS", ids);
      vi.stubEnv("PRIMARY_RUNTIME_PILOT_GROUP_BOT_IDS", ids);
      vi.stubEnv("PRIMARY_RUNTIME_PILOT_HANDOFF_BOT_IDS", recipientId);
      vi.stubEnv("PRIMARY_RUNTIME_PILOT_OUTBOUND_BOT_IDS", ids);
      vi.stubEnv("PRIMARY_RUNTIME_PILOT_LAUNCHER", process.execPath);
      const runtime = pilotRuntimeForBot(senderId)!;
      const sender = await profile(senderId);
      const { spaceId, userId } = actor;
      const base = { spaceId, userId, threadId, botId: senderId };
      const message = await createThreadMessage(sys, {
        threadId,
        role: "user",
        authorUserId: userId,
        blocks: [{ kind: "text", text: "@Coordinator /handoff Reviewer\nPrepare a brief" }],
      });
      const task = await sys.task.create({
        data: { ...base, status: "running", prompt: "Prepare a brief" },
      });
      const run = await sys.run.create({
        data: {
          ...base,
          taskId: task.id,
          status: "running",
          trigger: "user",
          sourceMessageId: message.id,
          primaryRuntime: runtime,
          primaryRuntimeRevision: sender.primaryRuntimeRevision,
        },
      });
      const recipientRevision = (await profile(recipientId)).primaryRuntimeRevision;
      const send = () =>
        runAsTenant(actor, () =>
          handoffToGroupBot(deps as never, run, groupId, {
            bot_id: recipientId,
            confirm_name: "Reviewer",
            message: "A verified brief",
            fromPrimaryPilot: { recipientRuntimeRevision: recipientRevision },
          }),
        );
      const recorded = () =>
        sys.message.findUnique({
          where: { threadId_clientNonce: { threadId, clientNonce: `group-handoff:${run.id}` } },
          include: { sourceRuns: true },
        });
      return { runtime, send, recorded, recipientRevision };
    }

    it("does not write a new handoff when the receiver switches away and back during drafting", async () => {
      const handoff = await startNativeHandoff();
      await choose(recipientId, "pi");
      await choose(recipientId, handoff.runtime);
      await expect(handoff.send()).resolves.toHaveProperty("error");
      await expect(handoff.recorded()).resolves.toBeNull();
    });

    it("pins the receiver's own connection, replays one receipt, and fences the queued child", async () => {
      const handoff = await startNativeHandoff();
      const outcomes = await Promise.all([handoff.send(), handoff.send()]);
      const receipt = await handoff.recorded();
      expect(receipt?.sourceRuns).toHaveLength(1);
      const child = receipt!.sourceRuns[0]!;
      expect(child).toMatchObject({
        botId: recipientId,
        trigger: "follow_up",
        primaryRuntime: handoff.runtime,
        primaryRuntimeRevision: handoff.recipientRevision,
        modelCredentialId: recipientKey,
        modelPinned: true,
      });
      for (const outcome of outcomes) expect(outcome).toMatchObject({ ok: true, runId: child.id });
      await choose(recipientId, "pi");
      await choose(recipientId, handoff.runtime);
      const runPi = vi.fn();
      const readSecret = vi.fn(async () => null);
      const executor = createRunExecutor({
        ...deps,
        secrets: [],
        secretStore: { get: readSecret },
        memoryProviders: { resolve: async () => null },
        events: createThreadEvents(prisma),
        runtime: { run: runPi },
      } as unknown as Parameters<typeof createRunExecutor>[0]);
      await runAsTenant(actor, () => executor.continueRun(child.id, "handoff-fixture-worker"));
      await expect(sys.run.findUniqueOrThrow({ where: { id: child.id } })).resolves.toHaveProperty(
        "status",
        "failed",
      );
      await expect(
        sys.event.findFirstOrThrow({ where: { runId: child.id, type: "run.failed" } }),
      ).resolves.toMatchObject({ payload: { error: expect.stringContaining("has changed") } });
      expect(runPi).not.toHaveBeenCalled();
      expect(readSecret).not.toHaveBeenCalled();
      await expect(handoff.send()).resolves.toMatchObject({ ok: true, runId: child.id });
      expect((await handoff.recorded())?.sourceRuns).toHaveLength(1);
    });
  },
);
