import { randomUUID } from "node:crypto";
import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import type { Actor, MeetingTurn } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { recordUsage } from "@rakazo/db";
import { MEETING_ANSWER_INSTRUCTIONS } from "./meeting-answers.prompt.js";

export function createMeetingAnswers(deps: {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  resolveModel: (scope: {
    userId: string;
    spaceId: string;
    botId: string;
  }) => Promise<AgentRunRequest["model"]>;
  offline: boolean;
}) {
  return async (
    actor: Actor,
    botId: string,
    turns: MeetingTurn[],
    question: string,
    signal?: AbortSignal,
  ) => {
    if (deps.offline) return "The launch draft is due Friday. Sam will check the final copy.";
    const transcript = JSON.stringify(turns);
    if (transcript.length > 75_000) {
      throw new ClientError(
        "BAD_REQUEST",
        "This transcript is too long to answer questions about.",
      );
    }
    const scope = { userId: actor.userId, spaceId: actor.spaceId, botId };
    const id = `meeting-answer:${randomUUID()}`;
    const model = await deps.resolveModel(scope);
    const budget = AbortSignal.timeout(45_000);
    const onUsage: NonNullable<AgentRunRequest["onUsage"]> = (event) =>
      recordUsage(deps.prisma, event, { ...scope, operationId: id, operationKind: "setup" }).then(
        () => {},
      );
    for await (const event of deps.runtime.run(
      {
        botId,
        runId: id,
        threadId: id,
        model,
        prompt: JSON.stringify({ question, transcript: turns }),
        instructions: MEETING_ANSWER_INSTRUCTIONS,
        history: [],
        tools: [],
        allowSilentEmpty: true,
        usageOperationKind: "setup",
        onUsage,
      },
      {
        ...scope,
        operationId: id,
        traceId: id,
        signal: signal ? AbortSignal.any([budget, signal]) : budget,
      },
    )) {
      if (event.type === "usage" && !event.accounted) await onUsage(event);
      if (event.type === "done" && event.text?.trim()) return event.text.trim();
    }
    throw new ClientError(
      "SERVICE_UNAVAILABLE",
      "The bot couldn’t answer this question. Try again.",
    );
  };
}
