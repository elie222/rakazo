import { describe, expect, it } from "vitest";
import { publicTaskView } from "./public-task.js";

const at = new Date("2026-11-25T00:00:00Z");
const later = new Date("2026-11-25T00:05:00Z");
const task = { id: "task-1", botId: "bot-1", createdAt: at, updatedAt: at };

describe("publicTaskView", () => {
  it("follows the newest run and joins the bot's text replies", () => {
    const view = publicTaskView(
      task,
      [
        { status: "failed", updatedAt: at },
        { status: "completed", updatedAt: later },
      ],
      [
        { id: "m1", blocks: [{ kind: "text", text: "First" }, { kind: "progress" }] },
        { id: "m2", blocks: [{ kind: "text", text: " Second " }] },
      ],
    );
    expect(view).toMatchObject({
      status: "completed",
      output: "First\n\nSecond",
      question: null,
      error: null,
      updated_at: later.toISOString(),
    });
  });

  it("shows what a waiting task asks", () => {
    const view = publicTaskView(
      task,
      [{ status: "waiting_input", updatedAt: at }],
      [{ id: "m1", blocks: [{ kind: "ask", text: "Post this reply?", status: "pending" }] }],
    );
    expect(view).toMatchObject({ status: "needs_input", question: "Post this reply?" });
  });

  it("shows an integration's pending question while the run still works", () => {
    const view = publicTaskView(
      task,
      [{ status: "running", updatedAt: at }],
      [
        {
          id: "m1",
          blocks: [
            {
              kind: "tool_question",
              status: "pending",
              expiresAt: "2999-01-01T00:00:00.000Z",
              question: { source: "Calendar", message: "Which calendar?", fields: [] },
            },
          ],
        },
      ],
    );
    expect(view).toMatchObject({ status: "needs_input", question: "Which calendar?" });
    const expired = publicTaskView(
      task,
      [{ status: "running", updatedAt: at }],
      [
        {
          id: "m1",
          blocks: [
            {
              kind: "tool_question",
              status: "pending",
              expiresAt: "2000-01-01T00:00:00.000Z",
              question: { source: "Calendar", message: "Which calendar?", fields: [] },
            },
          ],
        },
      ],
    );
    expect(expired).toMatchObject({ status: "working", question: null });
  });

  it("moves updated_at forward when a reply arrives", () => {
    const view = publicTaskView(
      task,
      [{ status: "running", updatedAt: at }],
      [{ id: "m1", blocks: [{ kind: "text", text: "More" }], createdAt: later }],
    );
    expect(view.updated_at).toBe(later.toISOString());
  });

  it("reads past a stored block missing its fields", () => {
    const view = publicTaskView(
      task,
      [{ status: "completed", updatedAt: at }],
      [{ id: "m1", blocks: [{ kind: "text" }, { kind: "text", text: "Kept" }] }],
    );
    expect(view.output).toBe("Kept");
  });

  it("reads as working before its run starts, and names no internal error when it fails", () => {
    expect(publicTaskView(task, [], []).status).toBe("working");
    expect(publicTaskView(task, [{ status: "failed", updatedAt: at }], []).error).toBe(
      "The bot could not finish this task",
    );
  });
});
