import type { APIRoute } from "astro";
import { markdownResponse } from "../agent-content";
import { voiceProvidersHubMarkdown } from "../voice-providers";

export const GET: APIRoute = ({ request }) =>
  markdownResponse(voiceProvidersHubMarkdown(), request.method);
