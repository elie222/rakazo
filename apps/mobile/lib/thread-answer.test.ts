import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Exercise the screen's actual answer handler without importing its native dependencies.
const source = readFileSync(new URL("../app/thread.tsx", import.meta.url), "utf8");
const handler = source.slice(
  source.indexOf("  const answerMessage = useCallback("),
  source.indexOf("  const openBot = useCallback("),
);

function setup(refresh: () => Promise<void>) {
  const scope = {
    useCallback: <T>(callback: T) => callback,
    botId: "bot-1",
    groupId: undefined,
    readOnly: false,
    rpc: vi.fn(async () => undefined),
    isCurrentTarget: () => true,
    refresh: vi.fn(refresh),
  };
  const compiled = ts.transpileModule(`${handler}\nreturn answerMessage;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const answerMessage = new Function(...Object.keys(scope), compiled)(...Object.values(scope)) as (
    message: { id: string; runId: string },
    answer: string,
    username?: string,
    dismiss?: boolean,
  ) => Promise<void>;
  return { ...scope, answerMessage };
}

describe("mobile ask answers", () => {
  it("sends the answer and username unchanged", async () => {
    const h = setup(async () => undefined);
    await h.answerMessage({ id: "message-1", runId: "run-1" }, "example-password", "ada");
    expect(h.rpc).toHaveBeenCalledWith("threads/answer", {
      botId: "bot-1",
      runId: "run-1",
      messageId: "message-1",
      answer: "example-password",
      username: "ada",
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("sends a dismissal with an empty answer and no username", async () => {
    const h = setup(async () => undefined);
    await h.answerMessage({ id: "message-1", runId: "run-1" }, "", undefined, true);
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
        h.answerMessage(
          { id: "message-1", runId: "run-1" },
          dismiss ? "" : "example-password",
          undefined,
          dismiss,
        ),
      ).resolves.toBeUndefined();
      expect(h.refresh).toHaveBeenCalledTimes(1);
    },
  );

  it("still fails when the server doesn't accept the answer", async () => {
    const h = setup(async () => undefined);
    h.rpc.mockRejectedValueOnce(new Error("offline"));
    await expect(
      h.answerMessage({ id: "message-1", runId: "run-1" }, "example-password", "ada"),
    ).rejects.toThrow("offline");
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
