import { describe, expect, it } from "vitest";
import { isGroupGoalScopedRun, scopeToGroupGoal } from "./local-group-history.js";

describe("goal-scoped parallel group context", () => {
  it("isolates internal peer and synthesis runs but not regular user messages", () => {
    expect(isGroupGoalScopedRun("local-group-team:root:peer", "worker prompt")).toBe(true);
    expect(
      isGroupGoalScopedRun(
        "local-agent-goal:root:1",
        "[Internal group coordination — final synthesis]",
      ),
    ).toBe(true);
    expect(isGroupGoalScopedRun("local-agent-goal:root:2", "Normal goal review")).toBe(false);
    expect(isGroupGoalScopedRun("send:human", "Human prompt")).toBe(false);
  });
  it("never includes old unrelated attachments or replies before the current goal", () => {
    const latestFirst = [
      { seq: 106, kind: "peer result" },
      { seq: 105, kind: "peer result" },
      { seq: 104, kind: "root answer" },
      { seq: 103, kind: "new user request and file" },
      { seq: 102, kind: "old unrelated attachment" },
      { seq: 101, kind: "old unrelated user request" },
    ];
    expect(scopeToGroupGoal(latestFirst, 103).map((x) => x.kind)).toEqual([
      "peer result",
      "peer result",
      "root answer",
      "new user request and file",
    ]);
    expect(scopeToGroupGoal(latestFirst, 99)).toHaveLength(latestFirst.length);
  });
});
