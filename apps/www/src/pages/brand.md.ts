import type { APIRoute } from "astro";
import { BRAND_MARKDOWN, markdownResponse } from "../agent-content";

export const GET: APIRoute = ({ request }) =>
  markdownResponse(BRAND_MARKDOWN, request.method);
