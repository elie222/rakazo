import type { APIRoute } from "astro";
import { markdownResponse, PLUGIN_SUBMIT_MARKDOWN } from "../../agent-content";

export const GET: APIRoute = ({ request }) =>
  markdownResponse(PLUGIN_SUBMIT_MARKDOWN, request.method);
