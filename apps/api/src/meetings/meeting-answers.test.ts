import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { estimateTextTokens } from "@rakazo/adapters";
import type { Actor, MeetingTurn } from "@rakazo/contracts";
import { MISSING_MODEL_RUN_ERROR } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createMeetingAnswers } from "./meeting-answers.js";

const actor: Actor = {
  userId: "meeting-user",
  spaceId: "meeting-space",
  email: "meeting@example.test",
  isDeploymentOwner: false,
};
const question = "What did the group decide?";
const shortTranscript = [
  { speaker: "Sam", startMs: 150, text: "We'll present the launch draft on Friday." },
];
const model = { provider: "fixture-model", id: "text", contextWindow: 8_192 };

function fixture(
  reply: (request: AgentRunRequest) => string | undefined,
  options?: { scripted?: boolean; offline?: boolean; model?: AgentRunRequest["model"] },
) {
  const runtime: AgentRuntime = {
    abort: vi.fn(async () => {}),
    describe: () => ({
      id: "fixture-runtime",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        streaming: true,
        compaction: true,
        tools: true,
        scripted: options?.scripted ?? false,
      },
    }),
    run: vi.fn<AgentRuntime["run"]>(async function* (request) {
      yield {
        type: "usage",
        provider: request.model.provider,
        model: request.model.id,
        inputTokens: 1,
        outputTokens: 1,
      };
      yield { type: "done", text: reply(request) };
    }),
  };
  const resolveModel = vi.fn(async () => options?.model ?? model);
  const usage = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    $transaction: (work: (tx: { usageRecord: { createMany: typeof usage } }) => Promise<void>) =>
      work({ usageRecord: { createMany: usage } }),
  } as unknown as PrismaClient;
  return {
    usage,
    run: vi.mocked(runtime.run),
    resolveModel,
    answer: createMeetingAnswers({
      prisma,
      runtime,
      resolveModel,
      offline: options?.offline ?? false,
    }),
  };
}

describe("meeting answers", () => {
  it("answers small transcripts with one scoped, tool-free call", async () => {
    const { answer, run, usage } = fixture(() => '{"answer":"The draft is due Friday."}');
    await expect(answer(actor, "meeting-bot", shortTranscript, question)).resolves.toBe(
      "The draft is due Friday.",
    );
    expect(run).toHaveBeenCalledOnce();
    const [request, context] = run.mock.calls[0]!;
    expect(JSON.parse(request.prompt)).toEqual({ question, transcript: shortTranscript });
    expect(request).toMatchObject({
      botId: "meeting-bot",
      history: [],
      tools: [],
      usageOperationKind: "answer",
    });
    expect(context).toMatchObject({
      botId: "meeting-bot",
      spaceId: actor.spaceId,
      userId: actor.userId,
    });
    expect(usage).toHaveBeenCalledOnce();
  });

  it("reads all chunks of a long meeting and then answers with the gathered evidence", async () => {
    const turns = Array.from({ length: 120 }, (_, index) => ({
      startMs: index * 30_000,
      speaker: index === 119 ? "Sam" : "Jordan",
      text:
        index === 119
          ? shortTranscript[0]!.text
          : "The team discussed the open items in the project this week. ".repeat(16),
    }));
    expect(JSON.stringify(turns).length).toBeGreaterThan(75_000);
    const read: MeetingTurn[] = [];
    const { answer, run, usage } = fixture((request) => {
      const payload = JSON.parse(request.prompt);
      if (payload.transcript) {
        read.push(...payload.transcript);
        return JSON.stringify({
          evidence: payload.transcript.at(-1)?.speaker === "Sam" ? "Sam set Friday." : "",
        });
      }
      expect(payload.evidence).toEqual(["Sam set Friday."]);
      return '{"answer":"Sam set Friday."}';
    });
    await expect(answer(actor, "meeting-bot", turns, question)).resolves.toBe("Sam set Friday.");
    expect(read).toEqual(turns);
    expect(run.mock.calls.length).toBeGreaterThan(2);
    expect(run.mock.calls.length).toBeLessThanOrEqual(13);
    for (const [request] of run.mock.calls) {
      expect(
        estimateTextTokens(request.prompt) +
          estimateTextTokens(request.instructions) +
          (request.model.maxTokens ?? 0),
      ).toBeLessThan(model.contextWindow);
    }
    expect(new Set(run.mock.calls.map(([request]) => request.runId)).size).toBe(
      run.mock.calls.length,
    );
    expect(usage).toHaveBeenCalledTimes(run.mock.calls.length);
  });

  it("splits a turn larger than the model window without losing text or speaker attribution", async () => {
    const text = "新しい情報📅".repeat(1_500);
    const turn = { speaker: "Sam", startMs: 510, text };
    const received: MeetingTurn[] = [];
    const { answer } = fixture((request) => {
      const payload = JSON.parse(request.prompt);
      if (!payload.transcript) return '{"answer":"The passage was reviewed."}';
      received.push(...payload.transcript);
      return '{"evidence":"A line from the passage."}';
    });
    await expect(answer(actor, "meeting-bot", [turn], question)).resolves.toBe(
      "The passage was reviewed.",
    );
    expect(received.length).toBeGreaterThan(1);
    expect(received.map((part) => part.text).join("")).toBe(text);
    expect(
      received.every((part) => part.speaker === turn.speaker && part.startMs === turn.startMs),
    ).toBe(true);
  });

  it.each([
    "Unknown model fixture-model/text",
    "I hit a problem: The provider refused the request.",
    "stopped",
    undefined,
  ])("reports unavailable for diagnostics or missing completion (%s)", async (output) => {
    const { answer } = fixture(() => output);
    await expect(answer(actor, "meeting-bot", shortTranscript, question)).rejects.toMatchObject({
      kind: "SERVICE_UNAVAILABLE",
    });
  });

  it("asks for a configured model instead of calling the scripted fallback", async () => {
    const { answer, run } = fixture(() => "done.", {
      model: { provider: "scripted", id: "scripted" },
    });
    await expect(answer(actor, "meeting-bot", shortTranscript, question)).rejects.toMatchObject({
      kind: "BAD_REQUEST",
      message: MISSING_MODEL_RUN_ERROR,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps the emulator deterministic without touching a model connection", async () => {
    const { answer, run, resolveModel } = fixture(() => undefined, {
      offline: true,
      scripted: true,
    });
    await expect(answer(actor, "meeting-bot", shortTranscript, question)).resolves.toBe(
      "The launch draft is due Friday. Sam will check the final copy.",
    );
    expect(run).not.toHaveBeenCalled();
    expect(resolveModel).not.toHaveBeenCalled();
  });
});
