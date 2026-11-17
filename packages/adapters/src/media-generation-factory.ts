import type { MediaGenerationProvider } from "@rakazo/adapter-kit";
import {
  FakeMediaGenerationProvider,
  FalMediaGenerationProvider,
  MuapiMediaGenerationProvider,
} from "./media-generation-provider.js";

export function createMediaGenerationProvider(
  env: NodeJS.ProcessEnv = process.env,
): MediaGenerationProvider | undefined {
  const kind = env.MEDIA_GENERATION_PROVIDER?.trim().toLowerCase();
  if (!kind || kind === "disabled") return undefined;
  if (kind === "fake") return new FakeMediaGenerationProvider();
  if (kind !== "fal" && kind !== "muapi") throw new Error("Unknown media generation provider");
  const apiKey = env.MEDIA_GENERATION_API_KEY?.trim();
  const imageModel = env.MEDIA_GENERATION_IMAGE_MODEL?.trim();
  const videoModel = env.MEDIA_GENERATION_VIDEO_MODEL?.trim();
  if (!apiKey || (!imageModel && !videoModel))
    throw new Error("Media generation requires credentials and at least one model");
  const Provider = kind === "muapi" ? MuapiMediaGenerationProvider : FalMediaGenerationProvider;
  return new Provider({
    apiKey,
    imageModel,
    videoModel,
    baseUrl: env.MEDIA_GENERATION_BASE_URL?.trim() || undefined,
  });
}
