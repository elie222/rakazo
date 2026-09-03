import { describe, expect, it } from "vitest";
import { advanceToolCallLoopGuard } from "./tool-loop.js";

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
});
