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
import type { ResolveHostname } from "../../../web/web-ssrf.js";

const API = "https://api.openai.com/v1";

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
      { ...this.options, endpoint: this.endpoint, model: this.options.imageModel, ...input },
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
