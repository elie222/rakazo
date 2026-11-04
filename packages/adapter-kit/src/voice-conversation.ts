import type { VoiceConversationEvent } from "@rakazo/contracts";

export interface VoiceConversationRequest {
  apiKey: string;
  voiceId: string;
  offerSdp: string;
  instructions: string;
  opening?: string;
}

export interface VoiceConversation {
  answerSdp: string;
  events: AsyncIterable<VoiceConversationEvent>;
  respond(delegationId: string, content: string): void;
  close(): Promise<void>;
}
