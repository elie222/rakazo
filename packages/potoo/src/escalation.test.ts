import { describe, expect, it } from "vitest";
import {
  buildEscalationTaskPrompt,
  buildRepairTaskPrompt,
  escalationClientNonce,
  extractPatrolJson,
  extractReportText,
  formatToolTranscript,
  repairClientNonce,
  shouldEscalate,
} from "./escalation.js";

const BLOODY =
  'lead\n```json\n{"findings": [{"title": "auth tokens expire early", "body": "broke", "evidence": [], "confidence": "confirmed", "severity": "high"}], "back_page": [], "record": "front page"}\n```';

describe("escalation", () => {
  it("gates on high severity", () => {
    expect(shouldEscalate(BLOODY)?.findings).toHaveLength(1);
    expect(
      shouldEscalate('```json\n{"findings": [], "back_page": [], "record": "quiet"}\n```'),
    ).toBeNull();
    expect(shouldEscalate("prose without a block")).toBeNull();
  });

  it("extracts text from message blocks", () => {
    expect(extractReportText([{ kind: "text", text: "hello" }])).toBe("hello");
    expect(extractReportText([{ kind: "image", artifactId: "a" }])).toBeNull();
    expect(extractReportText(null)).toBeNull();
  });

  it("formats the redacted tool transcript", () => {
    const transcript = formatToolTranscript([
      { type: "agent.tool.called", payload: { name: "shell_exec", executionId: "e1" } },
      {
        type: "agent.tool.completed",
        payload: { name: "shell_exec", outcome: "succeeded", durationMs: 42 },
      },
    ]);
    expect(transcript).toContain("call shell_exec (e1)");
    expect(transcript).toContain("done shell_exec outcome=succeeded 42ms");
    expect(formatToolTranscript([])).toContain("no tool calls");
  });

  it("builds the escalation prompt with the senior-correspondent marker", () => {
    const prompt = buildEscalationTaskPrompt('{"findings": []}', "call shell_exec (e1)");
    expect(prompt).toContain("Reporter's filing:");
    expect(extractPatrolJson(BLOODY)).toContain("auth tokens expire early");
  });

  it("namespaces the idempotency nonce per patrol run", () => {
    expect(escalationClientNonce("run-1")).toBe("potoo:escalation:run-1");
    expect(repairClientNonce("run-1")).toBe("potoo:repair:run-1");
  });

  it("builds the repair prompt with kind marker and original reply", () => {
    const prompt = buildRepairTaskPrompt("patrol", "some prose");
    expect(prompt).toContain("[potoo-repair: patrol]");
    expect(prompt).toContain("single fenced json block");
    expect(prompt).toContain("some prose");
  });
});
