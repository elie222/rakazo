import type { APIRoute } from "astro";
import { markdownResponse } from "../agent-content";
import { PRICING_MARKDOWN } from "../pricing";

export const GET: APIRoute = ({ request }) =>
  markdownResponse(PRICING_MARKDOWN, request.method);
