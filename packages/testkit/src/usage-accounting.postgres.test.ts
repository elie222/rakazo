import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import { recordUsage } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { runAutoReviewJudge } from "../../adapters/src/auto-review.js";
import { compactHistory } from "../../adapters/src/history-compaction.js";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { startModelEmulator } from "./model-emulator.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";
const usage = {
  prompt_tokens: 100,
  completion_tokens: 30,
  total_tokens: 130,
  prompt_tokens_details: { cached_tokens: 40 },
  completion_tokens_details: { reasoning_tokens: 10 },
  cost: 0.00012,
};

describe.skipIf(!enabled)("persisted Pi usage accounting", () => {
  it("accounts parent, subagent, failed and background calls once and retains spend after clear/delete", async () => {
    let openedCancellation = () => {};
    const cancellationStarted = new Promise<void>((resolve) => {
      openedCancellation = resolve;
    });
    let openedDeletion = () => {};
    const deletionStarted = new Promise<void>((resolve) => {
      openedDeletion = resolve;
    });
    const model = await startModelEmulator({
      steps: [
        {
          expect: () => {},
          response: {
            type: "tool",
            id: "helper-call",
            name: "run_subagent",
            arguments: { name: "helper", task: "Inspect the synthetic fixture." },
          },
          usage,
        },
        { expect: () => {}, response: { type: "text", text: "Fixture inspected." }, usage },
        { expect: () => {}, response: { type: "text", text: "Done." }, usage },
        { expect: () => {}, response: { type: "disconnect", text: "Partial result." }, usage },
        {
          expect: () => {},
          response: { type: "hold", text: "Still working.", onOpen: openedCancellation },
          usage,
        },
        {
          expect: (request) => {
            expect(request.tools ?? []).toHaveLength(0);
          },
          response: {
            type: "text",
            text: '{"decision":"pass","reason":"Synthetic task matches."}',
          },
          usage,
        },
        {
          expect: (request) => {
            expect(request.tools ?? []).toHaveLength(0);
          },
          response: {
            type: "text",
            text: "The helper inspected the fixture; the next request failed.",
          },
          usage,
        },
        {
          expect: () => {},
          response: { type: "hold", text: "Deleting while pending.", onOpen: openedDeletion },
          usage,
        },
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-usage-fixture-"));
    let stop: (() => Promise<void>) | undefined;
    try {
      const { createApp } = await import("../../../apps/api/src/app.ts");
      const handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        authUrl: origin,
        webOrigin: origin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "pi",
        contextStrategy: "current",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        composio: new ComposioEmulator(),
        encryptionKey: "usage-fixture-encryption-key",
      });
      stop = handles.stop;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `usage-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Usage fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      const rpc = async <T>(procedure: string, input: unknown = {}): Promise<T> => {
        const response = await handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, origin },
          body: JSON.stringify({ json: input }),
        });
        const body = (await response.json()) as { json: T; error?: { message: string } };
        if (response.status >= 400 || body.error)
          throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
        return body.json;
      };
      await rpc("models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        cacheCapabilities: {
          scope: "connection",
          retentionMode: "short",
          retentionMs: 300000,
          minimumTokens: 1024,
        },
      });
      const bot = await rpc<{ id: string }>("bots/create", {
        name: "Usage fixture",
        title: "",
        description: "",
        instructions: "Complete the synthetic task.",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, bot.id);
      await rpc("bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
      });
      const connectedThread = await handles.prisma.thread.findFirstOrThrow({
        where: { botId: bot.id },
      });
      expect(
        await handles.executor.resolveModel({
          userId: connectedThread.userId,
          spaceId: connectedThread.spaceId,
          botId: bot.id,
        }),
      ).toMatchObject({
        cacheCapabilities: {
          scope: "connection",
          retentionMode: "short",
          retentionMs: 300000,
          minimumTokens: 1024,
        },
      });
      const first = await rpc<{ runId: string }>("threads/send", {
        botId: bot.id,
        text: "Inspect the fixture using one helper.",
      });
      await expect
        .poll(
          async () => (await handles.prisma.run.findUnique({ where: { id: first.runId } }))?.status,
          { timeout: 15000, interval: 100 },
        )
        .toBe("completed");
      const failed = await rpc<{ runId: string }>("threads/send", {
        botId: bot.id,
        text: "Inspect the failure fixture.",
      });
      await expect
        .poll(
          async () =>
            (await handles.prisma.run.findUnique({ where: { id: failed.runId } }))?.status,
          { timeout: 15000, interval: 100 },
        )
        .toBe("failed");
      const cancelled = await rpc<{ runId: string }>("threads/send", {
        botId: bot.id,
        text: "Inspect the cancellation fixture.",
      });
      await cancellationStarted;
      await rpc("threads/stop", { botId: bot.id });
      // The API marks durable cancellation; production workers may learn it at lease renewal.
      // Abort explicitly here to deterministically exercise the producer-side accounting boundary.
      await handles.runtime.abort(cancelled.runId);
      await expect
        .poll(
          async () => handles.prisma.usageRecord.count({ where: { parentRunId: cancelled.runId } }),
          { timeout: 15000, interval: 100 },
        )
        .toBe(1);
      expect(
        (await handles.prisma.run.findUnique({ where: { id: cancelled.runId } }))?.status,
      ).toBe("cancelled");
      const thread = await handles.prisma.thread.findFirstOrThrow({ where: { botId: bot.id } });
      const review = await runAutoReviewJudge({
        runtime: handles.runtime,
        checker: { provider: model.model.provider, model: model.model.id },
        baseUrl: model.baseUrl,
        contextWindow: 32768,
        maxTokens: 4096,
        prompt: "Review the synthetic fixture.",
        runId: first.runId,
        spaceId: thread.spaceId,
        userId: thread.userId,
        botId: bot.id,
        threadId: thread.id,
        onUsage: (event) =>
          recordUsage(handles.prisma, event, {
            spaceId: thread.spaceId,
            userId: thread.userId,
            botId: bot.id,
            runId: first.runId,
            parentRunId: first.runId,
            operationKind: "setup",
            operationId: `auto-review:${first.runId}`,
          }),
      });
      expect(review.decision).toBe("pass");
      await compactHistory(
        {
          prisma: handles.prisma,
          runtime: handles.runtime,
          jobs: handles.jobs,
          memoryProviders: { resolve: async () => null },
          resolveModel: async (scope) => handles.executor.resolveModel(scope),
        },
        thread.id,
      );
      const rows = await handles.prisma.usageRecord.findMany({
        where: { botId: bot.id },
        orderBy: { createdAt: "asc" },
      });
      expect(rows).toHaveLength(7);
      expect(new Set(rows.map((row) => row.callId)).size).toBe(7);
      const delivered = rows[0]!;
      const replayEvent = {
        type: "usage" as const,
        provider: delivered.provider,
        model: delivered.model,
        callId: delivered.callId!,
        inputTokens: delivered.inputTokens,
        outputTokens: delivered.outputTokens,
      };
      await Promise.all(
        [1, 2].map(() =>
          recordUsage(handles.prisma, replayEvent, {
            spaceId: delivered.spaceId,
            userId: delivered.userId,
            botId: bot.id,
            runId: first.runId,
            parentRunId: first.runId,
          }),
        ),
      );
      expect(await handles.prisma.usageRecord.count({ where: { botId: bot.id } })).toBe(7);
      const summary = await rpc<{ totalTokens: number; modelCalls: number; runs: number }>(
        "usage/summary",
      );
      expect(summary).toMatchObject({ totalTokens: 910, modelCalls: 7, runs: 3 });
      for (const row of rows)
        expect(row).toMatchObject({
          inputTokens: 60,
          outputTokens: 30,
          cacheReadTokens: 40,
          cacheWriteTokens: null,
          reasoningTokens: 10,
          totalTokens: 130,
          costUsd: 0.00012,
          costSource: "provider-reported",
        });
      expect(rows.filter((row) => row.operationKind === "answer")).toHaveLength(4);
      expect(rows.find((row) => row.operationKind === "subagent")).toMatchObject({
        parentRunId: first.runId,
        runId: first.runId,
        agentId: expect.any(String),
      });
      expect(rows.find((row) => row.operationKind === "compaction")).toMatchObject({
        runId: null,
        parentRunId: null,
      });
      await rpc("threads/clear", { botId: bot.id });
      expect(await handles.prisma.usageRecord.count({ where: { botId: bot.id } })).toBe(7);
      const deletedWhilePending = await rpc<{ runId: string }>("threads/send", {
        botId: bot.id,
        text: "Inspect the deletion fixture.",
      });
      await deletionStarted;
      await rpc("bots/remove", { botId: bot.id, deleteMemories: false });
      await handles.runtime.abort(deletedWhilePending.runId);
      await expect
        .poll(
          async () =>
            handles.prisma.usageRecord.count({ where: { parentRunId: deletedWhilePending.runId } }),
          { timeout: 15000, interval: 100 },
        )
        .toBe(1);
      model.assertComplete();
      const retained = await handles.prisma.usageRecord.findMany({ where: { botId: bot.id } });
      expect(retained).toHaveLength(8);
      expect(retained.find((row) => row.parentRunId === deletedWhilePending.runId)).toMatchObject({
        inputTokens: 60,
        cacheReadTokens: 40,
        outputTokens: 30,
        costUsd: 0.00012,
        runId: null,
      });
      expect(retained.filter((row) => row.parentRunId === first.runId)).toHaveLength(4);
      expect(retained.every((row) => row.runId === null)).toBe(true);
    } finally {
      await stop?.();
      await model.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 45000);
});
