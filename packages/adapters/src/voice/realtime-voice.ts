import type { RealtimeCallModel, RealtimeCallSettings } from "@rakazo/contracts";

export type RealtimeVoiceModel = RealtimeCallModel;

/** A function the call may invoke; the server runs it and answers with toolResult. */
export interface RealtimeVoiceTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RealtimeVoiceToolCall {
  id: string;
  name: string;
  /** Raw JSON text from the model; callers parse and validate it. */
  args: string;
}

export interface RealtimeVoiceHistoryItem {
  role: "user" | "bot";
  text: string;
}

export type RealtimeVoiceEvent =
  | { kind: "transcript"; itemId: string; role: "user" | "bot"; text: string }
  | { kind: "turn"; itemId: string }
  | { kind: "responseStart"; responseId: string }
  | { kind: "responseDone"; responseId: string; toolCalls: RealtimeVoiceToolCall[] }
  | { kind: "error" };

export interface RealtimeVoiceConnection {
  answer: string;
  close(): void;
  onEvent(listener: (event: RealtimeVoiceEvent) => void): void;
  onClose(listener: () => void): void;
  /** Answers one tool call with JSON-serializable output. */
  toolResult(callId: string, output: unknown): void;
  /** Background status the model may relay; it does not count as anyone's words. */
  taskUpdate(outcome: string): void;
}

export interface RealtimeVoiceProvider {
  models: readonly RealtimeVoiceModel[];
  voices: readonly string[];
  connect(input: {
    offer: string;
    apiKey: string;
    settings: RealtimeCallSettings;
    voiceId: string;
    instructions: string;
    history: readonly RealtimeVoiceHistoryItem[];
    tools: readonly RealtimeVoiceTool[];
    signal: AbortSignal;
  }): Promise<RealtimeVoiceConnection>;
}
