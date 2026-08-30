import { describe, expect, it } from "vitest";
import { assertGoalTransition, canTransitionGoal } from "./goals/transitions.js";
import { assertProjectTransition, canTransitionProject } from "./projects/transitions.js";
import { assertWorkItemTransition, canTransitionWorkItem } from "./work/transitions.js";
import { buildWorkItemIdempotencyKey, normalizeTitle } from "./work/duplicate-detection.js";
import { wouldCreateCycle } from "./departments/hierarchy.js";
import { validateSopDefinition } from "./sop/validation.js";
import { DEFAULT_AUTHORITY, MANAGER_AUTHORITY } from "./employees/authority.js";

describe("WorkItem transitions", () => {
  it("allows backlog->ready->assigned->in_progress->completed", () => {
    expect(canTransitionWorkItem("backlog", "ready")).toBe(true);
    expect(canTransitionWorkItem("ready", "assigned")).toBe(true);
    expect(canTransitionWorkItem("assigned", "in_progress")).toBe(true);
    expect(canTransitionWorkItem("in_progress", "completed")).toBe(true);
  });
  it("rejects completed->backlog", () => {
    expect(canTransitionWorkItem("completed", "backlog")).toBe(false);
    expect(() => assertWorkItemTransition("completed", "backlog")).toThrow();
  });
  it("allows blocked->ready", () => {
    expect(canTransitionWorkItem("blocked", "ready")).toBe(true);
  });
  it("allows in_progress->waiting_review->reviewing->completed", () => {
    expect(canTransitionWorkItem("in_progress", "waiting_review")).toBe(true);
    expect(canTransitionWorkItem("waiting_review", "reviewing")).toBe(true);
    expect(canTransitionWorkItem("reviewing", "completed")).toBe(true);
  });
  it("rejects invalid arbitrary jump", () => {
    expect(canTransitionWorkItem("backlog", "completed")).toBe(false);
  });
  it("allows in_progress->waiting_approval->in_progress", () => {
    expect(canTransitionWorkItem("in_progress", "waiting_approval")).toBe(true);
    expect(canTransitionWorkItem("waiting_approval", "in_progress")).toBe(true);
  });
});

describe("Goal transitions", () => {
  it("draft->active->achieved->archived", () => {
    expect(canTransitionGoal("draft", "active")).toBe(true);
    expect(canTransitionGoal("active", "achieved")).toBe(true);
    expect(canTransitionGoal("achieved", "archived")).toBe(true);
  });
  it("rejects draft->achieved directly", () => {
    expect(canTransitionGoal("draft", "achieved")).toBe(false);
    expect(() => assertGoalTransition("draft", "achieved")).toThrow();
  });
  it("active->paused->active", () => {
    expect(canTransitionGoal("active", "paused")).toBe(true);
    expect(canTransitionGoal("paused", "active")).toBe(true);
  });
});

describe("Project transitions", () => {
  it("planned->active->completed", () => {
    expect(canTransitionProject("planned", "active")).toBe(true);
    expect(canTransitionProject("active", "completed")).toBe(true);
  });
  it("rejects planned->completed", () => {
    expect(canTransitionProject("planned", "completed")).toBe(false);
    expect(() => assertProjectTransition("planned", "completed")).toThrow();
  });
});

describe("duplicate detection", () => {
  it("normalizes title", () => {
    expect(normalizeTitle("  Hello   World ")).toBe("hello world");
  });
  it("builds deterministic key", () => {
    const k1 = buildWorkItemIdempotencyKey({ workspaceId: "w1", projectId: "p1", title: "Build landing page", source: "manual" });
    const k2 = buildWorkItemIdempotencyKey({ workspaceId: "w1", projectId: "p1", title: "  build LANDING page ", source: "manual" });
    expect(k1).toBe(k2);
  });
  it("different project yields different key", () => {
    const k1 = buildWorkItemIdempotencyKey({ workspaceId: "w1", projectId: "p1", title: "Task", source: "manual" });
    const k2 = buildWorkItemIdempotencyKey({ workspaceId: "w1", projectId: "p2", title: "Task", source: "manual" });
    expect(k1).not.toBe(k2);
  });
});

describe("department hierarchy cycle", () => {
  it("detects direct cycle", () => {
    expect(wouldCreateCycle([{ id: "a", parentDepartmentId: null }], "a", "a")).toBe(true);
  });
  it("detects indirect cycle", () => {
    const depts = [
      { id: "a", parentDepartmentId: null },
      { id: "b", parentDepartmentId: "a" },
      { id: "c", parentDepartmentId: "b" },
    ];
    expect(wouldCreateCycle(depts, "a", "c")).toBe(true);
  });
  it("allows valid parent", () => {
    const depts = [
      { id: "a", parentDepartmentId: null },
      { id: "b", parentDepartmentId: "a" },
    ];
    expect(wouldCreateCycle(depts, "c", "b")).toBe(false);
  });
});

describe("SOP validation", () => {
  it("validates trigger and steps", () => {
    expect(() => validateSopDefinition({ trigger: "", conditions: [], steps: [{ type: "create_work", instruction: "Do it" }] } as never)).toThrow();
    expect(() => validateSopDefinition({ trigger: "github.issue.created", conditions: [], steps: [] } as never)).toThrow();
    expect(() => validateSopDefinition({ trigger: "github.issue.created", conditions: [], steps: [{ type: "create_work", instruction: "Triage" }] } as never)).not.toThrow();
  });
});

describe("authority", () => {
  it("default employee cannot delegate", () => {
    expect(DEFAULT_AUTHORITY.canDelegate).toBe(false);
  });
  it("manager can delegate", () => {
    expect(MANAGER_AUTHORITY.canDelegate).toBe(true);
  });
});
