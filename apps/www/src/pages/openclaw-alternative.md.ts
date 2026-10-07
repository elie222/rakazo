import type { APIRoute } from "astro";
import { markdownResponse } from "../agent-content";
import { OPENCLAW_MARKDOWN } from "../guide";

export const GET: APIRoute = ({ request }) =>
  markdownResponse(OPENCLAW_MARKDOWN, request.method);
