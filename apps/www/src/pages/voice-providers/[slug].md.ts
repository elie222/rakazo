import type { APIRoute } from "astro";
import { markdownResponse } from "../../agent-content";
import { VOICE_PROVIDERS, voiceProviderMarkdown } from "../../voice-providers";

export function getStaticPaths() {
  return VOICE_PROVIDERS.map((provider) => ({
    params: { slug: provider.slug },
    props: { body: voiceProviderMarkdown(provider) },
  }));
}

export const GET: APIRoute = ({ props, request }) =>
  markdownResponse((props as { body: string }).body, request.method);
