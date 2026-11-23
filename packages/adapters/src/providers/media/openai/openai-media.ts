import type {
  AdapterContext,
  GeneratedMedia,
  MediaGenerationInput,
  MediaGenerationProvider,
  MediaVideoJob,
} from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
import { z } from "zod";
import {
  checkMediaModelId,
  mediaBaseUrl,
  requestImagesApiImage,
} from "../../../media/images-api.js";
import type { ResolveHostname } from "../../../web/web-ssrf.js";

const API = "https://api.openai.com/v1";

/** USD per million tokens: prompt text, image input, and image output. */
type TokenPrices = { text: number; imageIn: number; imageOut: number };

/** The image models a key can choose, newest first, with the provider's published token prices. */
export const OPENAI_IMAGE_MODELS: ReadonlyArray<{ id: string; label: string; price: TokenPrices }> =
  [
    { id: "gpt-image-2", label: "GPT Image 2", price: { text: 5, imageIn: 8, imageOut: 30 } },
    { id: "gpt-image-1", label: "GPT Image 1", price: { text: 5, imageIn: 10, imageOut: 40 } },
    {
      id: "gpt-image-1-mini",
      label: "GPT Image 1 Mini",
      price: { text: 2, imageIn: 2.5, imageOut: 8 },
    },
  ];

const tokens = z.number().int().nonnegative();
const usageBody = z.object({
  usage: z.object({
    output_tokens: tokens,
    input_tokens: tokens,
    input_tokens_details: z
      .object({ text_tokens: tokens, image_tokens: tokens })
      .partial()
      .optional(),
  }),
});

/** Prices the response's token usage from the model's list price; undefined for an unlisted model. */
export function openAIImageCost(model: string, body: unknown) {
  const price = OPENAI_IMAGE_MODELS.find((entry) => entry.id === model)?.price;
  const parsed = usageBody.safeParse(body);
  if (!price || !parsed.success) return undefined;
  const { input_tokens, output_tokens, input_tokens_details } = parsed.data.usage;
  const imageIn = input_tokens_details?.image_tokens ?? 0;
  const text = input_tokens_details?.text_tokens ?? input_tokens - imageIn;
  const usd =
    (text * price.text + imageIn * price.imageIn + output_tokens * price.imageOut) / 1_000_000;
  return { usd, source: "price_list" as const };
}

/**
 * The Images API (`POST /images/generations`). Servers that speak the same API work through the
 * base URL. It has no video.
 */
export class OpenAIMediaGenerationProvider implements MediaGenerationProvider {
  readonly id = "openai";
  readonly capabilities = { images: true, video: false, offline: false };
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
  }
  generateImage(input: MediaGenerationInput, context: AdapterContext): Promise<GeneratedMedia> {
    return requestImagesApiImage(
      {
        ...this.options,
        endpoint: this.endpoint,
        model: this.options.imageModel,
        cost: (body) => openAIImageCost(this.options.imageModel, body),
        ...input,
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
