import type { APIRoute } from "astro";
import { markdownResponse } from "../../agent-content";
import { INTEGRATION_PLATFORMS, integrationPlatformMarkdown } from "../../integration-platforms";

export function getStaticPaths() {
  return INTEGRATION_PLATFORMS.map((platform) => ({
    params: { slug: platform.slug },
    props: { body: integrationPlatformMarkdown(platform) },
  }));
}

export const GET: APIRoute = ({ props, request }) =>
  markdownResponse((props as { body: string }).body, request.method);
