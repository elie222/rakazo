export interface RealtimeVoiceModel {
  id: string;
  label: string;
}

export type RealtimeVoiceEvent =
  | { kind: "transcript"; itemId: string; role: "user" | "bot"; text: string }
  | { kind: "turn"; itemId: string }
  | { kind: "responseStart"; responseId: string }
  | { kind: "responseDone"; responseId: string; taskIds: string[] }
  | { kind: "error" };

export interface RealtimeVoiceConnection {
  answer: string;
  close(): void;
  onEvent(listener: (event: RealtimeVoiceEvent) => void): void;
  onClose(listener: () => void): void;
  taskResult(callId: string, outcome: string): void;
  taskUpdate(outcome: string): void;
}

export interface RealtimeVoiceProvider {
  models: readonly RealtimeVoiceModel[];
  connect(input: {
    offer: string;
    model: string;
    apiKey: string;
    voiceId: string;
    instructions: string;
    signal: AbortSignal;
  }): Promise<RealtimeVoiceConnection>;
}
