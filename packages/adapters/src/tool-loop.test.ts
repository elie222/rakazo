import { describe, expect, it } from "vitest";
import {
  advanceOverLimitActionCalls,
  advanceToolCallLoopGuard,
  isLoopGuardStopText,
  loopGuardStopText,
  MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS,
  overLimitStopText,
  toolCallStreakLength,
} from "./tool-loop.js";

describe("advanceToolCallLoopGuard", () => {
  it("allows a parallel Open Connector batch with distinct action inputs", () => {
    let streak = { key: undefined as string | undefined, count: 0 };

    for (let index = 0; index < 20; index += 1) {
      const result = advanceToolCallLoopGuard(streak, "mcp__open-connector__execute_action", {
        actionId: "records.get",
        input: { recordId: index + 1 },
      });
      streak = result.streak;
      expect(result.stuck).toBe(false);
    }
  });

  it("stops six consecutive calls with identical inputs", () => {
    let streak = { key: undefined as string | undefined, count: 0 };
    let stuck = false;

    for (let index = 0; index < 6; index += 1) {
      const result = advanceToolCallLoopGuard(streak, "shell", { command: "npm test" });
      streak = result.streak;
      stuck = result.stuck;
    }

    expect(stuck).toBe(true);
    expect(streak.count).toBe(6);
  });

  it("stops calls that differ only by a number in a text argument", () => {
    let streak = { key: undefined as string | undefined, count: 0 };
    let calls = 0;
    let stuck = false;

    while (!stuck && calls < 50) {
      calls += 1;
      const result = advanceToolCallLoopGuard(streak, "shell", { command: `echo noop-${calls}` });
      streak = result.streak;
      stuck = result.stuck;
    }

    expect(calls).toBe(25);
    expect(toolCallStreakLength(streak)).toBe(25);
  });

  it("reports the run that stopped it, identical or near-identical, in the stop text", () => {
    const stopText = (command: (call: number) => string) => {
      let streak = { key: undefined as string | undefined, count: 0 };
      for (let call = 1; call < 50; call += 1) {
        const result = advanceToolCallLoopGuard(streak, "shell", { command: command(call) });
        streak = result.streak;
        if (result.stuck) return loopGuardStopText("shell", streak);
      }
      throw new Error("never stopped");
    };

    expect(stopText(() => "npm test")).toContain(" with the same input 6 times in a row");
    expect(stopText((call) => `echo noop-${call}`)).toContain(
      " with nearly the same input 25 times",
    );
    expect(isLoopGuardStopText(stopText(() => "npm test"))).toBe(true);
    expect(isLoopGuardStopText("An ordinary reply")).toBe(false);
    expect(isLoopGuardStopText(stopText((call) => `echo noop-${call}`))).toBe(true);
  });

  it("keeps the identical stop count when a longer similar streak precedes it", () => {
    let streak = { key: undefined as string | undefined, count: 0 };
    for (let call = 1; call <= 10; call += 1) {
      streak = advanceToolCallLoopGuard(streak, "shell", { command: `echo noop-${call}` }).streak;
    }
    for (let call = 0; call < 6; call += 1) {
      streak = advanceToolCallLoopGuard(streak, "shell", { command: "echo noop-11" }).streak;
    }
    expect(loopGuardStopText("shell", streak)).toContain(" with the same input 6 times in a row");
  });

  it.each([
    ["shell", (n: number) => ({ command: `sed -n '${n * 100},${n * 100 + 99}p' big.log` })],
    ["browser_act", (n: number) => ({ actions: [{ kind: "click", ref: `e${n + 2}` }] })],
    ["browser_navigate", (n: number) => ({ url: `https://fixture.test/list?page=${n}` })],
  ])("lets a 12-step %s sequence that differs only by numbers finish", (name, input) => {
    let streak = { key: undefined as string | undefined, count: 0 };
    for (let step = 1; step <= 12; step += 1) {
      const result = advanceToolCallLoopGuard(streak, name, input(step));
      streak = result.streak;
      expect(result.stuck).toBe(false);
    }
  });

  it("lets a similar run broken by another call start over", () => {
    let streak = { key: undefined as string | undefined, count: 0 };
    for (let index = 0; index < 20; index += 1) {
      const command = index % 5 === 4 ? "pwd" : `echo noop-${index}`;
      const result = advanceToolCallLoopGuard(streak, "shell", { command });
      streak = result.streak;
      expect(result.stuck).toBe(false);
    }
  });
});

describe("advanceOverLimitActionCalls", () => {
  const over = { actions: Array.from({ length: 25 }, () => ({ kind: "click", x: 1, y: 1 })) };
  const ok = { actions: over.actions.slice(0, 24) };

  it("counts over-limit batches in a row across both action tools, even when they differ", () => {
    let count = 0;
    count = advanceOverLimitActionCalls(count, "computer_act", over);
    count = advanceOverLimitActionCalls(count, "browser_act", {
      actions: [...over.actions, ...over.actions],
    });
    count = advanceOverLimitActionCalls(count, "computer_act", over);
    expect(count).toBe(3);
    expect(count).toBeLessThan(MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS);
    expect(advanceOverLimitActionCalls(count, "computer_act", over)).toBe(
      MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS,
    );
  });

  it("counts expanded computer actions while leaving browser batches unexpanded", () => {
    const actions = Array.from({ length: 13 }, () => ({
      kind: "click",
      x: 1,
      y: 1,
      double: true,
    }));
    expect(advanceOverLimitActionCalls(3, "computer_act", { actions })).toBe(
      MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS,
    );
    expect(advanceOverLimitActionCalls(3, "computer_act", { actions: actions.slice(0, 12) })).toBe(
      0,
    );
    expect(advanceOverLimitActionCalls(3, "browser_act", { actions })).toBe(0);
  });

  it("ignores other tools and resets on a batch within the limit", () => {
    expect(advanceOverLimitActionCalls(2, "computer_observe", {})).toBe(2);
    expect(advanceOverLimitActionCalls(2, "computer_act", ok)).toBe(0);
    expect(advanceOverLimitActionCalls(2, "browser_act", undefined)).toBe(0);
  });
});

describe("overLimitStopText", () => {
  it("names the over-limit batches and is recognised as a loop-guard stop", () => {
    const text = overLimitStopText("Computer act", 4);
    expect(text).toContain("with too many actions 4 times in a row");
    expect(text).not.toContain("same input");
    expect(isLoopGuardStopText(text)).toBe(true);
  });
});
