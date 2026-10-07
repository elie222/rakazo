import type { APIRoute } from "astro";
import { markdownResponse } from "../agent-content";
import { GROK_ALTERNATIVE_MARKDOWN } from "../grok-alternative";

export const GET: APIRoute = ({ request }) =>
  markdownResponse(GROK_ALTERNATIVE_MARKDOWN, request.method);
