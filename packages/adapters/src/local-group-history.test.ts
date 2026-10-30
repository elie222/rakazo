import { describe, expect, it } from "vitest";
import {
  groupGoalRootId,
  isGroupGoalScopedRun,
  scopeToGroupGoal,
  scopeToGroupGoalWithSource,
  trimGroupHistoryWithSource,
} from "./local-group-history.js";

describe("goal-scoped parallel group context", () => {
  it("checks both peer and owner synthesis nonces against the original request", () => {
    expect(groupGoalRootId("local-group-team:root1:peer2")).toBe("root1");
    expect(groupGoalRootId("local-agent-goal:root1:1")).toBe("root1");
    expect(groupGoalRootId("local-agent-goal:root1:3")).toBe("root1");
    expect(groupGoalRootId("local-agent-goal:root1:invalid")).toBeNull();
    expect(groupGoalRootId("local-group-team:root1:")).toBeNull();
    expect(groupGoalRootId("send:root1")).toBeNull();
  });
  it("restores the original request and attachments beyond a 200-message window", () => {
    const source = { seq: 1, role: "user", blocks: [{ kind: "file", id: "attachment" }] };
    const latest = Array.from({ length: 200 }, (_, index) => ({
      seq: 202 - index,
      role: "bot",
      blocks: [] as { kind: string; id?: string }[],
    }));
    const scoped = scopeToGroupGoalWithSource(latest, 1, source);
    expect(scoped).toHaveLength(201);
    expect(scoped.at(-1)).toEqual(source);
    expect(scopeToGroupGoalWithSource([...latest, source], 1, source)).toHaveLength(201);
    expect(scopeToGroupGoalWithSource(latest, 1, { ...source, seq: 0 })).toEqual(latest);
  });
  it("isolates internal peer and synthesis runs but not regular user messages", () => {
    expect(isGroupGoalScopedRun("local-group-team:root:peer", "worker prompt")).toBe(true);
    expect(
      isGroupGoalScopedRun(
        "local-agent-goal:root:1",
        "[Internal group coordination — final synthesis]",
      ),
    ).toBe(true);
    expect(
      isGroupGoalScopedRun("local-agent-goal:root:2", "[Internal goal assessment, round 2/3]"),
    ).toBe(true);
    expect(isGroupGoalScopedRun("local-agent-goal:root:2", "Normal goal review")).toBe(true);
    expect(isGroupGoalScopedRun("local-agent-goal:root:not-a-round", "Normal goal review")).toBe(false);
    expect(isGroupGoalScopedRun("send:human", "Human prompt")).toBe(false);
  });
  it("keeps the source request after trimming 200 newer messages", () => {
    const source = { id: "original", role: "user", content: "request + attachment" };
    const newer = Array.from({ length: 200 }, (_, index) => ({
      id: `reply-${index}`,
      role: "assistant",
      content: "peer response",
    }));
    const trimmed = trimGroupHistoryWithSource([source, ...newer], "original", 200);
    expect(trimmed).toHaveLength(200);
    expect(trimmed[0]).toEqual(source);
    expect(trimmed.at(-1)).toEqual(newer.at(-1));
    expect(trimGroupHistoryWithSource([source, ...newer], "original", 1)).toEqual([source]);
    // If the source already falls inside the window, don't introduce duplicates.
    expect(trimGroupHistoryWithSource([...newer, source], "original", 200).at(-1)).toEqual(
      source,
    );
    expect(trimGroupHistoryWithSource(newer, "missing", 200)).toEqual(newer);
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
