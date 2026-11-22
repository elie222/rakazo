import { describe, expect, it, vi } from "vitest";
import { postRoutineMessage } from "./routine-message.js";

describe("postRoutineMessage", () => {
  const line = {
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    role: "system" as const,
    text: "Inbox sweep routine: failed",
    clientNonce: "routine-failed:run-1",
  };
  const failing = (error: unknown) =>
    ({
      prisma: { $transaction: vi.fn(async () => Promise.reject(error)) },
      events: { notify: vi.fn(async () => undefined) },
    }) as unknown as Parameters<typeof postRoutineMessage>[0];

  it("skips a line it can't write, unless its caller retries", async () => {
    const error = new Error("connection lost");
    await expect(postRoutineMessage(failing(error), line)).resolves.toBeUndefined();
    await expect(postRoutineMessage(failing(error), { ...line, required: true })).rejects.toBe(
      error,
    );
  });

  it("counts a line an earlier attempt wrote under its nonce as written", async () => {
    const duplicate = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    await expect(
      postRoutineMessage(failing(duplicate), { ...line, required: true }),
    ).resolves.toBeUndefined();
  });
});
