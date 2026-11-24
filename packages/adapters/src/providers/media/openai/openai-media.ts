import type {
  AdapterContext,
  GeneratedMedia,
  MediaGenerationInput,
  MediaGenerationProvider,
  MediaVideoJob,
} from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
import {
  checkMediaModelId,
  mediaBaseUrl,
  requestImagesApiImage,
} from "../../../media/images-api.js";
import { UNKNOWN_MODEL_PRICES } from "../../../media/media-generation-provider.js";
import type { ResolveHostname } from "../../../web/web-ssrf.js";

const API = "https://api.openai.com/v1";
/**
 * Per model: the most one image costs at the auto size and quality this adapter requests (high
 * quality, the dearer of square and landscape), and the token rates its usage is billed at, all in
 * micro-dollars. Models without token usage are charged their image price.
 */
const MODELS = new Map<string, { imageMicros: number; textToken?: number; outputToken?: number }>([
  ["gpt-image-2", { imageMicros: 211_000, textToken: 5, outputToken: 30 }],
  ["gpt-image-1", { imageMicros: 250_000, textToken: 5, outputToken: 40 }],
  ["gpt-image-1-mini", { imageMicros: 52_000, textToken: 2, outputToken: 8 }],
  ["dall-e-3", { imageMicros: 40_000 }],
  ["dall-e-2", { imageMicros: 20_000 }],
]);

/** The image models a key's picker offers, newest first. */
export const OPENAI_IMAGE_MODELS = [
  { id: "gpt-image-2", label: "GPT Image 2" },
  { id: "gpt-image-1", label: "GPT Image 1" },
  { id: "gpt-image-1-mini", label: "GPT Image 1 Mini" },
] as const;

/**
 * The Images API (`POST /images/generations`). Servers that speak the same API work through the
 * base URL. It has no video.
 */
export class OpenAIMediaGenerationProvider implements MediaGenerationProvider {
  readonly id = "openai";
  readonly capabilities = { images: true, video: false, offline: false };
  readonly prices;
  private readonly endpoint: string;
  constructor(
    private readonly options: {
      apiKey: string;
      imageModel: string;
      baseUrl?: string;
      fetch?: typeof fetch;
      resolveHostname?: ResolveHostname;
    },
  ) {
    this.endpoint = `${mediaBaseUrl(options.baseUrl ?? API)}/images/generations`;
    checkMediaModelId(options.imageModel);
    this.prices = {
      imageMicros: MODELS.get(options.imageModel)?.imageMicros ?? UNKNOWN_MODEL_PRICES.imageMicros,
      videoMicros: 0,
    };
  }
  generateImage(input: MediaGenerationInput, context: AdapterContext): Promise<GeneratedMedia> {
    return requestImagesApiImage(
      {
        ...this.options,
        endpoint: this.endpoint,
        model: this.options.imageModel,
        ...input,
        costMicros: (usage) => {
          const rates = MODELS.get(this.options.imageModel);
          // A partial count would undercharge, so the image is then charged at its saved price.
          if (
            !rates?.outputToken ||
            usage.input_tokens === undefined ||
            usage.output_tokens === undefined
          )
            return undefined;
          return (
            usage.input_tokens * (rates.textToken ?? 0) + usage.output_tokens * rates.outputToken
          );
        },
      },
      context,
    );
  }
  async generateVideo(): Promise<MediaVideoJob> {
    throw new MediaGenerationError("unsupported");
  }
  async pollVideo(): Promise<MediaVideoJob> {
    throw new MediaGenerationError("unsupported");
  }
}
