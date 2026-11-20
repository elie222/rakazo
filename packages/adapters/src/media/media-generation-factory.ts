import type { MediaGenerationProvider } from "@rakazo/adapter-kit";
import { OpenAIMediaGenerationProvider } from "../providers/media/openai/openai-media.js";
import {
  FakeMediaGenerationProvider,
  FalMediaGenerationProvider,
} from "./media-generation-provider.js";

export function createMediaGenerationProvider(
  env: NodeJS.ProcessEnv = process.env,
): MediaGenerationProvider | undefined {
  const kind = env.MEDIA_GENERATION_PROVIDER?.trim().toLowerCase();
  if (!kind || kind === "disabled") return undefined;
  if (kind === "fake") return new FakeMediaGenerationProvider();
  if (kind !== "fal" && kind !== "openai") throw new Error("Unknown media generation provider");
  const apiKey = env.MEDIA_GENERATION_API_KEY?.trim();
  const imageModel = env.MEDIA_GENERATION_IMAGE_MODEL?.trim();
  const videoModel = env.MEDIA_GENERATION_VIDEO_MODEL?.trim();
  // Blank means the provider's own default, so one provider's URL never reaches another.
  const baseUrl = env.MEDIA_GENERATION_BASE_URL?.trim() || undefined;
  if (!apiKey || (!imageModel && !videoModel))
    throw new Error("Media generation requires credentials and at least one model");
  if (kind === "openai") {
    if (videoModel || !imageModel)
      throw new Error("This media generation provider makes images only; set an image model");
    return new OpenAIMediaGenerationProvider({ apiKey, imageModel, baseUrl });
  }
  return new FalMediaGenerationProvider({ apiKey, imageModel, videoModel, baseUrl });
}
