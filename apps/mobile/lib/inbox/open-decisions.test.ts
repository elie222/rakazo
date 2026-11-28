import type { ThreadMessage } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";

vi.mock("../api/api", () => ({ rpc: vi.fn() }));

const { openDecision } = await import("./open-decisions");

const message = (seq: number, runId: string, blocks: unknown[]) =>
  ({ id: `m${seq}`, seq, runId, blocks }) as Pick<ThreadMessage, "id" | "seq" | "runId" | "blocks">;
const ask = (text: string, status = "pending") => ({ kind: "ask", text, status });
const waiting = { runId: "run-1", status: "waiting_input" as const };

it("is the pending question that ends the chat, from the waiting run", () => {
  expect(
    openDecision(waiting, [
      message(1, "run-0", [{ kind: "text", text: "Earlier" }]),
      message(2, "run-1", [ask("Send the NDA for signing?")]),
    ]),
  ).toEqual({ messageId: "m2", text: "Send the NDA for signing?" });
});

it("is gone once the chat moved on, even while the run is still marked waiting", () => {
  expect(
    openDecision(waiting, [
      message(2, "run-1", [ask("OK to deploy the launch changes?")]),
      message(3, "run-2", [{ kind: "text", text: "Merged and live." }]),
    ]),
  ).toBeNull();
});

it("is never a failed or finished run, whatever its last card says", () => {
  const messages = [message(2, "run-1", [ask("Send it?")])];
  expect(openDecision({ runId: "run-1", status: "failed" }, messages)).toBeNull();
  expect(openDecision({ runId: "run-1", status: "completed" }, messages)).toBeNull();
});

it("leaves out answered questions and forms that expired", () => {
  expect(openDecision(waiting, [message(2, "run-1", [ask("Send it?", "answered")])])).toBeNull();
  const form = {
    kind: "tool_question",
    status: "pending",
    expiresAt: "2026-01-01T00:00:00.000Z",
    question: { source: "Calendar", message: "Pick a time", fields: [] },
  };
  expect(
    openDecision(waiting, [message(2, "run-1", [form])], Date.parse("2026-01-02T00:00:00.000Z")),
  ).toBeNull();
});
