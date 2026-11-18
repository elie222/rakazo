import { randomUUID } from "node:crypto";
import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { estimateTextTokens, listPiCatalog } from "@rakazo/adapters";
import type { Actor, MeetingTurn } from "@rakazo/contracts";
import { anySignal, ClientError, deadlineSignal, MISSING_MODEL_RUN_ERROR } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { memberHasModelAccess, recordUsage } from "@rakazo/db";
import * as z from "zod";
import {
  MEETING_ANSWER_INSTRUCTIONS,
  meetingEvidenceInstructions,
  meetingEvidencePrompt,
  meetingTranscriptPrompt,
} from "./meeting-answers.prompt.js";

const MAX_CONTEXT_TOKENS = 40_000;
const UNKNOWN_MODEL_CONTEXT_TOKENS = 16_384;
const MAX_REPLY_TOKENS = 1_024;
const MAX_EXCERPTS = 12;
const MAX_EVIDENCE_CHARS = 720;
const MESSAGE_OVERHEAD_TOKENS = 192;
const answerSchema = z.object({ answer: z.string().trim().min(1).max(8_000) });
const evidenceSchema = z.object({ evidence: z.string().trim() });

type MeetingModelScope = Pick<Actor, "userId" | "spaceId"> & { botId: string };

interface MeetingAnswerDeps {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  resolveModel: (scope: MeetingModelScope) => Promise<AgentRunRequest["model"]>;
  offline: boolean;
  billingEnabled?: boolean;
}

export function createMeetingAnswers(deps: MeetingAnswerDeps) {
  return async (
    actor: Actor,
    botId: string,
    turns: MeetingTurn[],
    question: string,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    if (deps.offline) return "The launch draft is due Friday. Sam will check the final copy.";
    const scope = { userId: actor.userId, spaceId: actor.spaceId, botId };
    if (deps.billingEnabled && !(await memberHasModelAccess(deps.prisma, scope))) {
      throw new ClientError("FORBIDDEN", "An active plan is required to use this bot’s model.");
    }
    const model = await resolveMeetingModel(deps, scope);
    const catalog = listPiCatalog().find(
      (entry) => entry.provider === model.provider && entry.id === model.id,
    );
    const contextWindow =
      model.contextWindow ?? catalog?.contextWindow ?? UNKNOWN_MODEL_CONTEXT_TOKENS;
    const outputTokens = Math.min(
      model.maxTokens ?? catalog?.maxTokens ?? MAX_REPLY_TOKENS,
      MAX_REPLY_TOKENS,
      Math.max(1, Math.floor(contextWindow / 4)),
    );
    // Leave room for the runtime's message framing and differences between provider tokenizers.
    const inputTokens = Math.min(
      MAX_CONTEXT_TOKENS,
      Math.floor(contextWindow * 0.85) - outputTokens - MESSAGE_OVERHEAD_TOKENS,
    );
    const encodedQuestion = JSON.stringify(question);
    const questionTokens = estimateTextTokens(encodedQuestion);
    const instructionsTokens = Math.max(
      estimateTextTokens(MEETING_ANSWER_INSTRUCTIONS),
      estimateTextTokens(meetingEvidenceInstructions(MAX_EVIDENCE_CHARS)),
    );
    // Both prompt shapes add only a few fixed JSON keys and brackets.
    const availableTokens = inputTokens - questionTokens - instructionsTokens - 32;
    if (availableTokens < 512) {
      throw largerModelRequired();
    }
    const chunks = transcriptChunks(turns, availableTokens);
    const stop = new AbortController();
    const budget = deadlineSignal(45_000, signal ? anySignal([stop.signal, signal]) : stop.signal);

    try {
      let answerPrompt = meetingTranscriptPrompt(encodedQuestion, chunks[0] ?? "");
      if (chunks.length > 1) {
        // Keep the reduction in one call, leaving room even if the source uses non-Latin scripts.
        const tokensPerExcerpt = Math.floor(availableTokens / chunks.length) - 4;
        const evidenceChars = Math.min(MAX_EVIDENCE_CHARS, Math.floor(tokensPerExcerpt / 2));
        const notes = await Promise.all(
          chunks.map(async (chunk) => {
            const { evidence } = await run(
              meetingEvidenceInstructions(evidenceChars),
              meetingTranscriptPrompt(encodedQuestion, chunk),
              evidenceSchema,
              Math.min(outputTokens, tokensPerExcerpt),
            );
            return limitEvidence(evidence, tokensPerExcerpt);
          }),
        );
        answerPrompt = meetingEvidencePrompt(question, notes.filter(Boolean));
      }
      const { answer } = await run(
        MEETING_ANSWER_INSTRUCTIONS,
        answerPrompt,
        answerSchema,
        outputTokens,
      );
      return answer;
    } finally {
      stop.abort();
    }

    async function run<T extends z.ZodType>(
      instructions: string,
      prompt: string,
      schema: T,
      maxTokens: number,
    ): Promise<z.infer<T>> {
      budget.throwIfAborted();
      const id = `meeting-answer:${randomUUID()}`;
      const onUsage: NonNullable<AgentRunRequest["onUsage"]> = async (event) => {
        await recordUsage(deps.prisma, event, {
          ...scope,
          operationId: id,
          operationKind: "answer",
        });
      };
      for await (const event of deps.runtime.run(
        {
          botId,
          runId: id,
          threadId: id,
          model: { ...model, maxTokens },
          prompt,
          instructions,
          history: [],
          tools: [],
          allowSilentEmpty: true,
          usageOperationKind: "answer",
          onUsage,
        },
        { ...scope, operationId: id, traceId: id, signal: budget },
      )) {
        if (event.type === "usage" && !event.accounted) await onUsage(event);
        if (event.type === "done") {
          budget.throwIfAborted();
          const result = schema.safeParse(parseCompletion(event.text ?? ""));
          if (result.success) return result.data;
          break;
        }
      }
      throw new ClientError(
        "SERVICE_UNAVAILABLE",
        "The bot couldn’t answer this question. Try again.",
      );
    }
  };
}

async function resolveMeetingModel(
  deps: Pick<MeetingAnswerDeps, "runtime" | "resolveModel">,
  scope: MeetingModelScope,
) {
  if (!deps.runtime.describe().capabilities.scripted) {
    try {
      const model = await deps.resolveModel(scope);
      if (model.provider !== "scripted") return model;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== MISSING_MODEL_RUN_ERROR) throw error;
    }
  }
  throw new ClientError("BAD_REQUEST", MISSING_MODEL_RUN_ERROR);
}

function largerModelRequired() {
  return new ClientError(
    "BAD_REQUEST",
    "Connect a model with a larger context window to ask about this transcript.",
  );
}

function parseCompletion(text: string): unknown {
  const trimmed = text.trim();
  // Some providers fence their JSON even when asked for a bare object.
  const body = /^```(?:json)?\s+([\s\S]*?)\s+```$/i.exec(trimmed)?.[1] ?? trimmed;
  try {
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function transcriptChunks(turns: MeetingTurn[], maxTokens: number) {
  const chunks: string[] = [];
  let rows: string[] = [];
  let tokens = 0;
  for (const turn of turns) {
    for (const [row, cost] of serializeTurn(turn, maxTokens)) {
      if (tokens + cost > maxTokens) {
        chunks.push(rows.join(","));
        if (chunks.length >= MAX_EXCERPTS) throw largerModelRequired();
        rows = [];
        tokens = 0;
      }
      rows.push(row);
      tokens += cost;
    }
  }
  if (rows.length) chunks.push(rows.join(","));
  return chunks;
}

function* serializeTurn(turn: MeetingTurn, maxTokens: number): Generator<[string, number]> {
  const encoded = JSON.stringify(turn);
  const tokens = estimateTextTokens(encoded) + 1;
  if (tokens <= maxTokens) {
    yield [encoded, tokens];
    return;
  }

  // Even the longest single utterance can be split without slicing a Unicode code point
  // or dropping its speaker and starts-at metadata.
  const framing = estimateTextTokens(JSON.stringify({ ...turn, text: "" })) + 4;
  const text = [...turn.text];
  if (maxTokens - framing < 6) throw largerModelRequired();
  const charactersPerPiece = Math.floor((maxTokens - framing) / 6);
  for (let index = 0; index < text.length; index += charactersPerPiece) {
    const piece = JSON.stringify({
      ...turn,
      text: text.slice(index, index + charactersPerPiece).join(""),
    });
    yield [piece, estimateTextTokens(piece) + 1];
  }
}

function limitEvidence(evidence: string, maxTokens: number) {
  const tokens = estimateTextTokens(JSON.stringify(evidence));
  if (tokens <= maxTokens) return evidence;
  // Trim by character budget only when a provider ignores the requested output limit.
  return evidence.slice(0, Math.floor((maxTokens - 4) / 6));
}
