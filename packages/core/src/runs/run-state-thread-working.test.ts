import { describe, expect, it } from "vitest";
import { threadRunWorking } from "./run-state.js";

describe("threadRunWorking", () => {
  it("follows the status the chat shows", () => {
    expect(threadRunWorking("running", undefined, "bot-1")).toBe(true);
    expect(threadRunWorking("queued", [], "bot-1")).toBe(true);
    expect(threadRunWorking("completed", undefined, "bot-1")).toBe(false);
    expect(threadRunWorking(undefined, undefined, "bot-1")).toBe(false);
  });

  it("counts the thread's own active runs when the shown run has settled", () => {
    const runs = [{ status: "running", botId: "bot-1" }];
    expect(threadRunWorking("completed", runs, "bot-1")).toBe(true);
  });

  it("ignores another bot's run and runs waiting on the user", () => {
    expect(threadRunWorking("completed", [{ status: "running", botId: "bot-2" }], "bot-1")).toBe(
      false,
    );
    expect(
      threadRunWorking(undefined, [{ status: "waiting_input", botId: "bot-1" }], "bot-1"),
    ).toBe(false);
  });
});
