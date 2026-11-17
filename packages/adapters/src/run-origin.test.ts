import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { loadRunOrigin, runStartedByMember } from "./run-origin.js";

it.each([false, true])(
  "only retains cancelled parent provenance for a typed answer (%s)",
  async (typedAnswer) => {
    const origin = {
      id: "parent",
      status: "cancelled",
      trigger: "user",
      threadId: "chat",
      sourceMessage: { id: "request" },
    };
    const prisma = {
      run: { findFirst: vi.fn(async () => origin) },
      message: {
        findMany: vi.fn(async () => [
          {
            id: "question",
            blocks: [
              {
                kind: "ask",
                status: "answered",
                ...(typedAnswer ? { answerMessageId: "typed-answer" } : { answer: "deny" }),
              },
            ],
          },
        ]),
      },
    } as unknown as PrismaClient;
    const result = await loadRunOrigin(prisma, {
      id: "helper",
      trigger: "helper",
      delegatedFromRunId: "parent",
      botId: "bot",
      spaceId: "space",
      userId: "user",
    });
    expect(result).toEqual(typedAnswer ? origin : null);
  },
);

describe("runStartedByMember", () => {
  const theirs = { ownerStartedRun: true, nonOwnerChat: false };
  it.each(["user", "call_end"])("includes a %s run", (trigger) => {
    expect(runStartedByMember(trigger, theirs)).toBe(true);
  });
  it("includes a follow-up the member wrote", () => {
    expect(runStartedByMember("follow_up", theirs)).toBe(true);
    expect(runStartedByMember("follow_up", { ownerStartedRun: false, nonOwnerChat: false })).toBe(
      false,
    );
  });
  it.each(["routine", "webhook", "bot_message", "messaging", "helper"])(
    "excludes a %s run even when the conversation was theirs",
    (trigger) => {
      expect(runStartedByMember(trigger, theirs)).toBe(false);
    },
  );
  it("excludes another member's chat", () => {
    expect(runStartedByMember("user", { ownerStartedRun: true, nonOwnerChat: true })).toBe(false);
  });
});
