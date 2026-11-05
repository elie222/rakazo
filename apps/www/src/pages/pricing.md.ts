import type { APIRoute } from "astro";
import { markdownResponse } from "../agent-content";
import { PRICING_MARKDOWN } from "../pricing";

// Served here, not through agent-content: the edge middleware bundles that file and cannot resolve workspace packages.

export const GET: APIRoute = ({ request }) =>
  markdownResponse(PRICING_MARKDOWN, request.method);
