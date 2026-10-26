import { describe, expect, it, vi } from "vitest";
import type { ThreadAnswerContext } from "./thread-answer";
import { answerThreadMessage } from "./thread-answer";

function setup(refresh: () => Promise<void>, overrides: Partial<ThreadAnswerContext> = {}) {
  const rpc = vi.fn(async (_proc: string, _body: Record<string, unknown>) => undefined as unknown);
  const spies = { rpc, refresh: vi.fn(refresh), markRead: vi.fn() };
  const context: ThreadAnswerContext = {
    botId: "bot-1",
    groupId: undefined,
    readOnly: false,
    isCurrentTarget: () => true,
    ...spies,
    ...overrides,
  };
  return {
    ...spies,
    answerMessage: (
      message: { id: string; runId?: string },
      answer: string,
      username?: string,
      dismiss?: boolean,
    ) => answerThreadMessage(context, message, answer, username, dismiss),
  };
}

const message = { id: "message-1", runId: "run-1" };

describe("mobile ask answers", () => {
  it("sends the answer and username unchanged", async () => {
    const h = setup(async () => undefined);
    await h.answerMessage(message, "example-password", "ada");
    expect(h.markRead).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith("threads/answer", {
      botId: "bot-1",
      runId: "run-1",
      messageId: "message-1",
      answer: "example-password",
      username: "ada",
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("targets the group in a group thread", async () => {
    const h = setup(async () => undefined, { botId: undefined, groupId: "group-1" });
    await h.answerMessage(message, "yes");
    expect(h.rpc).toHaveBeenCalledWith("threads/answer", {
      groupId: "group-1",
      runId: "run-1",
      messageId: "message-1",
      answer: "yes",
    });
  });

  it("sends a dismissal with an empty answer and no username", async () => {
    const h = setup(async () => undefined);
    await h.answerMessage(message, "", undefined, true);
    expect(h.rpc).toHaveBeenCalledWith("threads/answer", {
      botId: "bot-1",
      runId: "run-1",
      messageId: "message-1",
      answer: "",
      dismiss: true,
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "reports an accepted answer or dismissal when refresh fails: %s",
    async (dismiss) => {
      const h = setup(async () => {
        throw new Error("offline");
      });
      await expect(
        h.answerMessage(message, dismiss ? "" : "example-password", undefined, dismiss),
      ).resolves.toBeUndefined();
      expect(h.refresh).toHaveBeenCalledTimes(1);
    },
  );

  it("still fails when the server doesn't accept the answer", async () => {
    const h = setup(async () => undefined);
    h.rpc.mockRejectedValueOnce(new Error("offline"));
    await expect(h.answerMessage(message, "example-password", "ada")).rejects.toThrow("offline");
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("skips the refresh after the viewer has moved to another thread", async () => {
    const h = setup(async () => undefined, { isCurrentTarget: () => false });
    await h.answerMessage(message, "yes");
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it.each([
    ["read-only", { readOnly: true }, message],
    ["targetless", { botId: undefined }, message],
    ["runless", {}, { id: "message-1" }],
  ] as const)("sends nothing for a %s answer", async (_name, overrides, target) => {
    const h = setup(async () => undefined, overrides);
    await h.answerMessage(target, "yes");
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.markRead).not.toHaveBeenCalled();
  });
});
