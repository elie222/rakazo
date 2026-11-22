import { describe, expect, it } from "vitest";
import { openaiRealtimeVoice, parseRealtimeVoiceEvent } from "./openai-realtime.js";

describe("realtime voice sideband events", () => {
  it("accepts completed speech and marks which participant spoke", () => {
    const common = { item_id: "item_1", transcript: "Hallo Chief." };
    expect(
      parseRealtimeVoiceEvent(
        JSON.stringify({
          ...common,
          type: "conversation.item.input_audio_transcription.completed",
        }),
      ),
    ).toEqual({ kind: "transcript", itemId: "item_1", role: "user", text: "Hallo Chief." });
    expect(
      parseRealtimeVoiceEvent(
        JSON.stringify({
          ...common,
          type: "response.output_audio_transcript.done",
        }),
      ),
    ).toEqual({ kind: "transcript", itemId: "item_1", role: "bot", text: "Hallo Chief." });
  });

  it("delegates completed responses only and ignores generated arguments", () => {
    const output = [
      { type: "function_call", name: "unknown", call_id: "call_other" },
      {
        type: "function_call",
        name: "ask_bot",
        call_id: "call_1",
        arguments: '{"prompt":"untrusted"}',
      },
    ];
    expect(
      parseRealtimeVoiceEvent(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          name: "ask_bot",
          call_id: "call_1",
        }),
      ),
    ).toBeUndefined();
    const complete = (status: string) =>
      parseRealtimeVoiceEvent(
        JSON.stringify({
          type: "response.done",
          response: { id: "response_1", status, output },
        }),
      );
    expect(complete("completed")).toEqual({
      kind: "responseDone",
      responseId: "response_1",
      taskIds: ["call_1"],
    });
    expect(complete("cancelled")).toEqual({
      kind: "responseDone",
      responseId: "response_1",
      taskIds: [],
    });
  });

  it("does not treat a client-added conversation item as spoken dialogue", () => {
    expect(
      parseRealtimeVoiceEvent(
        JSON.stringify({
          type: "conversation.item.created",
          role: "user",
          item_id: "item_1",
          transcript: "untrusted",
        }),
      ),
    ).toBeUndefined();
  });

  it("rejects an unknown model before contacting the provider", async () => {
    await expect(
      openaiRealtimeVoice.connect({
        model: "unlisted",
        offer: "v=0",
        apiKey: "test",
        instructions: "",
        voiceId: "",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Unknown realtime model");
  });
});
