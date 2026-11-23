import type { AdapterContext } from "./types.js";

export type MediaGenerationInput = { prompt: string };
export type GeneratedMedia = {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "video/mp4";
  /** What it cost in USD: reported by the provider, or priced from the adapter's own list. */
  cost?: { usd: number; source: "provider" | "price_list" };
};
export type MediaVideoJob =
  | { id: string; status: "queued" | "running"; progress?: number }
  | { id: string; status: "completed"; output: GeneratedMedia }
  | { id: string; status: "failed" };
export interface MediaGenerationProvider {
  readonly id: string;
  readonly capabilities: { images: boolean; video: boolean; offline: boolean };
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
