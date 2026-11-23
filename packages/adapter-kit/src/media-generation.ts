import type { AdapterContext } from "./types.js";

export type MediaGenerationInput = { prompt: string };
export type GeneratedMedia = {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "video/mp4";
  /** What the provider reported this generation cost, in micro-dollars, when it reports one. */
  costMicros?: number;
};
export type MediaVideoJob =
  | { id: string; status: "queued" | "running"; progress?: number }
  | { id: string; status: "completed"; output: GeneratedMedia }
  | { id: string; status: "failed" };
export interface MediaGenerationProvider {
  readonly id: string;
  readonly capabilities: { images: boolean; video: boolean; offline: boolean };
  /**
   * The most one image and one video clip, as this provider requests them, cost in micro-dollars.
   * Checked against the organization's media balance before submitting, and charged when the
   * provider does not report the actual cost.
   */
  readonly prices: { imageMicros: number; videoMicros: number };
  generateImage(input: MediaGenerationInput, context: AdapterContext): Promise<GeneratedMedia>;
  generateVideo(input: MediaGenerationInput, context: AdapterContext): Promise<MediaVideoJob>;
  pollVideo(id: string, context: AdapterContext): Promise<MediaVideoJob>;
}
export type MediaGenerationErrorCode =
  | "invalid_input"
  | "unsupported"
  | "authentication"
  | "rate_limit"
  | "provider_failure"
  | "output_limit";
export class MediaGenerationError extends Error {
  constructor(public readonly code: MediaGenerationErrorCode) {
    super(`Media generation: ${code}`);
    this.name = "MediaGenerationError";
  }
}
