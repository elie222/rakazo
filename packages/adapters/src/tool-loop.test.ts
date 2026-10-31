import { describe, expect, it } from "vitest";
import {
  advanceToolCallLoopGuard,
  isLoopGuardStopText,
  loopGuardStopText,
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
