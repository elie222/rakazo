import type { LoginFieldInput } from "@rakazo/contracts";
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
      fields?: readonly LoginFieldInput[],
      dismiss?: boolean,
      remember?: false,
    ) => answerThreadMessage(context, message, answer, fields, dismiss, remember),
  };
}

const message = { id: "message-1", runId: "run-1" };

describe("mobile ask answers", () => {
  it("sends a login's fields unchanged with an empty answer and no username", async () => {
    const h = setup(async () => undefined);
    const fields = [
      { label: "Username", value: " ada ", hidden: false },
      { label: "Password", value: "example-password", hidden: true },
    ];
    await h.answerMessage(message, "", fields);
    expect(h.markRead).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith("threads/answer", {
      botId: "bot-1",
      runId: "run-1",
      messageId: "message-1",
      answer: "",
      fields,
    });
    expect(h.rpc.mock.lastCall![1]).not.toHaveProperty("username");
    // Saved to the Vault unless the person turned that off.
    expect(h.rpc.mock.lastCall![1]).not.toHaveProperty("remember");
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("sends remember false for a login used for this run only", async () => {
    const h = setup(async () => undefined);
    const fields = [{ label: "Password", value: "example-password", hidden: true }];
    await h.answerMessage(message, "", fields, undefined, false);
    expect(h.rpc).toHaveBeenCalledWith("threads/answer", {
      botId: "bot-1",
      runId: "run-1",
      messageId: "message-1",
      answer: "",
      fields,
      remember: false,
    });
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
    await expect(h.answerMessage(message, "example-password")).rejects.toThrow("offline");
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
