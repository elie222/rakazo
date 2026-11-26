import type { PublicTask } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  ChatCompletionRequestSchema,
  chatCompletion,
  chatCompletionChunk,
  latestUserText,
  modelList,
  openAiError,
  unsentText,
} from "./openai-compat.js";

const task: PublicTask = {
  id: "task-1",
  object: "task",
  bot_id: "bot-1",
  status: "needs_input",
  output: "Found three threads.",
  question: "Should I keep watching?",
  error: null,
  created_at: "2026-11-25T00:00:00.000Z",
  updated_at: "2026-11-25T00:00:00.000Z",
};

describe("OpenAI-compatible chat", () => {
  it("accepts an official SDK request, extra fields included", () => {
    const parsed = ChatCompletionRequestSchema.parse({
      model: "bot-1",
      messages: [
        { role: "system", content: "Be brief" },
        { role: "user", content: "Hi" },
      ],
      stream: true,
      temperature: 0.2,
      stream_options: { include_usage: true },
    });
    expect(parsed.stream).toBe(true);
  });

  it("sends only the newest user message, text parts joined", () => {
    expect(
      latestUserText([
        { role: "user", content: "earlier" },
        { role: "assistant", content: "reply" },
        {
          role: "user",
          content: [
            { type: "text", text: "Watch r/news" },
            { type: "image_url" },
            { type: "text", text: "for launches" },
          ],
        },
      ]),
    ).toBe("Watch r/news\nfor launches");
    expect(() => latestUserText([{ role: "system", content: "only a system message" }])).toThrow(
      "end with a user message with text",
    );
    expect(() =>
      latestUserText([
        { role: "user", content: "earlier" },
        { role: "assistant", content: "reply" },
      ]),
    ).toThrow("end with a user message with text");
    expect(() => latestUserText([{ role: "user", content: "   " }])).toThrow(
      "end with a user message with text",
    );
    expect(() => latestUserText([{ role: "user", content: "a".repeat(100_001) }])).toThrow(
      "longer than",
    );
  });

  it("answers in the chat.completion shape, with the question the bot asked", () => {
    expect(chatCompletion(task, "bot-1", 1_700_000_000)).toEqual({
      id: "chatcmpl-task-1",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "bot-1",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Found three threads.\n\nShould I keep watching?",
            refusal: null,
          },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  });

  it("marks an answer cut off while the bot still works", () => {
    const working = { ...task, status: "working" as const, question: null };
    expect(chatCompletion(working, "bot-1", 1).choices[0]?.finish_reason).toBe("length");
  });

  it("streams chat.completion.chunk events", () => {
    expect(chatCompletionChunk(task, "bot-1", 1, { content: "Hi" })).toEqual({
      id: "chatcmpl-task-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "bot-1",
      choices: [{ index: 0, delta: { content: "Hi" }, logprobs: null, finish_reason: null }],
    });
    expect(chatCompletionChunk(task, "bot-1", 1, {}, "stop").choices[0]?.finish_reason).toBe(
      "stop",
    );
  });

  it("streams only text not sent yet, and goes on after a reply changes", () => {
    expect(unsentText("", "Hello")).toBe("Hello");
    expect(unsentText("Hello", "Hello\n\nworld")).toBe("\n\nworld");
    expect(unsentText("Done.\n\nShall I post it?", "Done.\n\nPosted it.")).toBe("\n\nPosted it.");
    expect(unsentText("Hello there", "Hello")).toBe("");
  });

  it("lists bots as models and errors in OpenAI's shape", () => {
    expect(
      modelList([{ id: "bot-1", name: "Scout", space: { id: "space-1", name: "Home" } }]),
    ).toEqual({
      object: "list",
      data: [{ id: "bot-1", object: "model", created: 0, owned_by: "Home", name: "Scout" }],
    });
    expect(openAiError(401, "Invalid API key")).toEqual({
      error: {
        message: "Invalid API key",
        type: "authentication_error",
        param: null,
        code: null,
      },
    });
  });
});
