import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { loadRunOrigin } from "./run-origin.js";

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
