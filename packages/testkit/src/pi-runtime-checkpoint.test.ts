import type { Message } from "@earendil-works/pi-ai";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { approvalPausedToolResult } from "../../adapters/src/approval-effect.js";
import { builtinAgentTools } from "../../adapters/src/builtin-tools.js";
import { PiAgentRuntime } from "../../adapters/src/pi-runtime.js";
import { serializeTurnCheckpoint } from "../../adapters/src/turn-checkpoint.js";
import type { ModelEmulatorRequest } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

async function collect(events: AsyncIterable<AgentRuntimeEvent>) {
  const result: AgentRuntimeEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("paused turn context", () => {
  it.each(["approval", "ask_user", "request_takeover", "request_secret"])(
    "restores earlier evidence and the pending %s result before the first model call",
    async (pause) => {
      const pendingName = pause === "approval" ? "write_file" : pause;
      const args =
        pause === "ask_user"
          ? { question: "Which fixture?", options: ["One", "Two"] }
          : pause === "approval"
            ? { path: "fixture.txt", content: "approved fixture" }
            : pause === "request_secret"
              ? { label: "Fixture code", purpose: "otp" }
              : { reason: "Complete fixture step" };
      let pausedPrefix: ModelEmulatorRequest["messages"] = [];
      const model = await startModelEmulator({
        steps: [
          {
            expect() {},
            response: {
              type: "tool",
              id: "evidence-call",
              name: "read_file",
              arguments: { path: "fixture.txt" },
            },
          },
          {
            expect(request) {
              pausedPrefix = request.messages;
            },
            response: { type: "tool", id: "pending-call", name: pendingName, arguments: args },
          },
          {
            expect(request) {
              expect(request.messages.slice(0, pausedPrefix.length)).toEqual(pausedPrefix);
              const evidence = request.messages.findIndex(
                (message) => message.role === "tool" && message.tool_call_id === "evidence-call",
              );
              expect(evidence).toBeGreaterThan(0);
              expect(JSON.stringify(request.messages[evidence])).toContain(
                "unique-checkpoint-evidence",
              );
              const pending = request.messages.findIndex(
                (message) => message.role === "tool" && message.tool_call_id === "pending-call",
              );
              expect(pending).toBeGreaterThan(evidence);
              expect(JSON.stringify(request.messages[pending])).toContain("fixture-resumed");
            },
            response: { type: "text", text: "Done." },
          },
        ],
      });
      const executions: unknown[] = [];
      const request: AgentRunRequest = {
        runId: `checkpoint-${pause}`,
        botId: "fixture-bot",
        threadId: "fixture-thread",
        instructions: "Complete the fixture.",
        prompt: "Read the fixture then complete the next step.",
        history: [{ id: "fixture-history", role: "user", content: "Earlier fixture context" }],
        tools: builtinAgentTools.filter((tool) => ["read_file", pendingName].includes(tool.name)),
        model: model.model,
        executeTool: async (name, callArgs) => {
          if (name === "read_file") return { evidence: "unique-checkpoint-evidence" };
          executions.push(callArgs);
          return approvalPausedToolResult();
        },
      };
      try {
        const first = await collect(new PiAgentRuntime().run(request));
        const checkpoint = first.findLast((event) => event.type === "checkpoint");
        expect(checkpoint, "pause must preserve a durable transcript").toBeDefined();
        if (checkpoint?.type !== "checkpoint") return;
        executions.length = 0;
        await collect(
          new PiAgentRuntime().run({
            ...request,
            turnCheckpoint: checkpoint.blob,
            resumeToolResult: { content: [{ type: "text", text: "fixture-resumed" }] },
            executeTool: async (_name, callArgs) => {
              executions.push(callArgs);
              return { result: "fixture-resumed" };
            },
          } as AgentRunRequest),
        );
        model.assertComplete();
        expect(executions).toEqual(
          pause === "ask_user" || pause === "request_takeover" ? [] : [args],
        );
      } finally {
        await model.close();
      }
    },
  );
  it("does not answer an unexecuted later interaction with the earlier answer", async () => {
    const model = await startModelEmulator({
      steps: [
        {
          expect(request) {
            expect(
              request.messages
                .filter((message) => message.role === "tool")
                .map((message) => [message.tool_call_id, message.content]),
            ).toEqual([
              ["first-question", "first-answer"],
              ["second-question", "second-answer"],
            ]);
          },
          response: { type: "text", text: "Done." },
        },
      ],
    });
    const messages: Message[] = [
      { role: "user", content: "Choose both fixtures.", timestamp: 0 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "first-question",
            name: "ask_user",
            arguments: { question: "First fixture?", options: ["One", "Two"] },
          },
          {
            type: "toolCall",
            id: "second-question",
            name: "ask_user",
            arguments: { question: "Second fixture?", options: ["Three", "Four"] },
          },
        ],
        api: "openai-completions",
        provider: model.model.provider,
        model: model.model.id,
        stopReason: "toolUse",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: 0,
      } as Message,
    ];
    const request: AgentRunRequest = {
      runId: "fixture-batch",
      botId: "fixture-bot",
      threadId: "fixture-thread",
      instructions: "Complete fixture",
      prompt: "Choose both fixtures.",
      history: [],
      tools: builtinAgentTools.filter((tool) => tool.name === "ask_user"),
      model: model.model,
    };
    const blob = serializeTurnCheckpoint({
      version: 1,
      provider: model.model.provider,
      model: model.model.id,
      systemPrompt: request.instructions,
      pendingToolCallId: "first-question",
      messages,
    });
    try {
      const first = await collect(
        new PiAgentRuntime().run({
          ...request,
          turnCheckpoint: blob,
          resumeToolResult: { content: [{ type: "text", text: "first-answer" }] },
        }),
      );
      expect(model.requests).toHaveLength(0);
      expect(first.filter((event) => event.type === "ask")).toEqual([
        expect.objectContaining({ text: "Second fixture?" }),
      ]);
      const next = first.findLast((event) => event.type === "checkpoint");
      expect(next?.type).toBe("checkpoint");
      if (next?.type !== "checkpoint") return;
      await collect(
        new PiAgentRuntime().run({
          ...request,
          turnCheckpoint: next.blob,
          resumeToolResult: { content: [{ type: "text", text: "second-answer" }] },
        }),
      );
      model.assertComplete();
    } finally {
      await model.close();
    }
  });
});
