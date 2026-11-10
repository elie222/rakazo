import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it } from "vitest";
import { logLoopGuardStop, logToolRefusal } from "./tool-completion-audit.js";

const target = {
  spaceId: "space-1",
  threadId: "thread-1",
  botId: "bot-1",
  runId: "run-1",
  trigger: "bot_message",
};

function capture() {
  const sink = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  return sink;
}

afterEach(() => {
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

describe("tool refusal log", () => {
  it("logs why a call was refused, with the run it happened in", () => {
    const sink = capture();
    const reason = logToolRefusal(target, "update_bot", {
      error: "Bot management tools need a run you started.",
    });
    expect(reason).toBe("Bot management tools need a run you started.");
    expect(sink.events).toEqual([
      expect.objectContaining({
        message: "agent.tool.refused",
        "run.id": "run-1",
        "run.trigger": "bot_message",
        tool: "update_bot",
        "tool.refusal": reason,
      }),
    ]);
  });

  it("leaves out the names a refusal quotes, and secrets", () => {
    const sink = capture();
    logToolRefusal(target, "update_group", {
      error: 'Bot "Chief of "staff"" is not in group "Launch".',
    });
    logToolRefusal(target, "shell", { error: "Blocked: hunter2-token is not allowed." }, [
      "hunter2-token",
    ]);
    expect(sink.events.map((event) => event["tool.refusal"])).toEqual([
      'Bot "…".',
      "Blocked: [redacted] is not allowed.",
    ]);
  });

  it("logs nothing for a result that ends the turn without an error", () => {
    const sink = capture();
    expect(logToolRefusal(target, "update_bot", { terminate: true })).toBeUndefined();
    expect(sink.events).toEqual([]);
  });
});

describe("loop guard stop log", () => {
  it("names the tool, the count and the refusal it kept getting", () => {
    const sink = capture();
    logLoopGuardStop(target, {
      tool: "update_bot",
      reason: "repeated_calls",
      count: 6,
      failures: 5,
      refusal: "Bot management tools need a run you started.",
    });
    logLoopGuardStop(target, {
      tool: "computer_act",
      reason: "over_limit_actions",
      count: 4,
      failures: 0,
    });
    expect(sink.events).toEqual([
      expect.objectContaining({
        message: "run.loop_guard_stopped",
        "run.id": "run-1",
        tool: "update_bot",
        "loop.reason": "repeated_calls",
        "loop.count": 6,
        "loop.failures": 5,
        "tool.refusal": "Bot management tools need a run you started.",
      }),
      expect.not.objectContaining({ "tool.refusal": expect.anything() }),
    ]);
  });
});
