import type { APIRoute } from "astro";
import { markdownResponse } from "../agent-content";
import { SELF_HOST_MARKDOWN } from "../guide";

export const GET: APIRoute = ({ request }) =>
  markdownResponse(SELF_HOST_MARKDOWN, request.method);
