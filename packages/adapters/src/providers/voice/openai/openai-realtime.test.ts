import type { RealtimeCallSettings } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  historyItems,
  openaiRealtimeVoice,
  parseRealtimeVoiceEvent,
  realtimeSession,
} from "./openai-realtime.js";

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

  it("reports tool calls only from completed responses", () => {
    const output = [
      { type: "message", call_id: "not_a_call" },
      { type: "function_call", name: "search_history", call_id: "call_other" },
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
      toolCalls: [
        { id: "call_other", name: "search_history", args: "{}" },
        { id: "call_1", name: "ask_bot", args: '{"prompt":"untrusted"}' },
      ],
    });
    expect(complete("cancelled")).toEqual({
      kind: "responseDone",
      responseId: "response_1",
      toolCalls: [],
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
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      openaiRealtimeVoice.connect({
        offer: "v=0",
        apiKey: "test",
        settings: settings({ model: "unlisted" }),
        instructions: "",
        voiceId: "",
        history: [],
        tools: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Unknown realtime model");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

function settings(overrides: Partial<RealtimeCallSettings> = {}): RealtimeCallSettings {
  return { provider: "openai", model: "gpt-realtime-2.1", ...overrides };
}

describe("realtime session settings", () => {
  const base = { voiceId: "cedar", instructions: "Be brief.", tools: [] };

  it("maps every chosen setting onto the session", () => {
    const session = realtimeSession({
      ...base,
      settings: settings({
        speed: 1.2,
        patience: "patient",
        noiseReduction: "headset",
        language: "de",
        thinking: "thorough",
        maxOutputTokens: 800,
      }),
      tools: [{ name: "search_history", description: "Search", parameters: { type: "object" } }],
    });
    expect(session).toMatchObject({
      model: "gpt-realtime-2.1",
      max_output_tokens: 800,
      reasoning: { effort: "medium" },
      audio: {
        input: {
          transcription: { model: "gpt-transcribe", language: "de" },
          noise_reduction: { type: "near_field" },
          turn_detection: {
            type: "semantic_vad",
            eagerness: "low",
            interrupt_response: true,
            create_response: true,
          },
        },
        output: { voice: "cedar", speed: 1.2 },
      },
      tools: [
        {
          type: "function",
          name: "search_history",
          description: "Search",
          parameters: { type: "object" },
        },
      ],
    });
    expect(session.instructions).toContain("The caller speaks German.");
  });

  it("keeps the previous session when no option is chosen", () => {
    const tools = [{ name: "ask_bot", description: "Ask", parameters: { type: "object" } }];
    expect(realtimeSession({ ...base, voiceId: "cedar", tools, settings: settings() })).toEqual({
      type: "realtime",
      model: "gpt-realtime-2.1",
      instructions: "Be brief.",
      output_modalities: ["audio"],
      audio: {
        input: {
          // The only deliberate change: the deprecated transcription model is replaced.
          transcription: { model: "gpt-transcribe" },
          turn_detection: { type: "server_vad", interrupt_response: true, create_response: true },
        },
        output: { voice: "cedar" },
      },
      tools: [{ type: "function", ...tools[0] }],
    });
  });

  it("leaves out what the model cannot do", () => {
    const session = realtimeSession({
      ...base,
      voiceId: "fable",
      settings: settings({ model: "gpt-realtime-2.1-mini", thinking: "thorough" }),
    });
    expect(session).not.toHaveProperty("reasoning");
    expect(session.audio.output).toEqual({ voice: "marin" });
  });

  it.each([
    ["patient", "low"],
    ["balanced", "medium"],
    ["quick", "high"],
  ] as const)("turns %s listening into semantic turn detection (%s)", (patience, eagerness) => {
    const session = realtimeSession({ ...base, settings: settings({ patience, silenceMs: 900 }) });
    expect(session.audio.input.turn_detection).toEqual({
      type: "semantic_vad",
      eagerness,
      interrupt_response: true,
      create_response: true,
    });
  });

  it.each([
    ["headset", { type: "near_field" }],
    ["room", { type: "far_field" }],
    ["off", null],
  ] as const)("maps the %s microphone onto noise reduction", (noiseReduction, expected) => {
    const session = realtimeSession({ ...base, settings: settings({ noiseReduction }) });
    expect(session.audio.input).toHaveProperty("noise_reduction", expected);
  });

  it("tunes the quiet gap only while no patience is chosen", () => {
    const session = realtimeSession({
      ...base,
      settings: settings({ vadThreshold: 0.7, silenceMs: 900 }),
    });
    expect(session.audio.input.turn_detection).toEqual({
      type: "server_vad",
      threshold: 0.7,
      silence_duration_ms: 900,
      interrupt_response: true,
      create_response: true,
    });
  });

  it("lists thinking only for reasoning models", () => {
    const thinking = openaiRealtimeVoice.models
      .filter((model) => model.capabilities.includes("thinking"))
      .map((model) => model.id);
    expect(thinking).toEqual(["gpt-realtime-2.1", "gpt-realtime-2"]);
    expect(openaiRealtimeVoice.voices.slice(0, 2)).toEqual(["marin", "cedar"]);
  });
});

describe("realtime chat history", () => {
  it("chains earlier turns from the conversation root in chat order", () => {
    const items = historyItems([
      { role: "user", text: "Wie war das Meeting?" },
      { role: "bot", text: "Kurz und gut." },
      { role: "user", text: "Und morgen?" },
    ]);
    expect(items.map((event) => [event.previous_item_id, event.item.id, event.item.role])).toEqual([
      ["root", "history_0", "user"],
      ["history_0", "history_1", "assistant"],
      ["history_1", "history_2", "user"],
    ]);
    expect(items[1]?.item.content).toEqual([{ type: "output_text", text: "Kurz und gut." }]);
    expect(items[0]?.item.content).toEqual([{ type: "input_text", text: "Wie war das Meeting?" }]);
  });
});
