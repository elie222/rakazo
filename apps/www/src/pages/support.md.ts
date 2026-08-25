import type { APIRoute } from "astro";
import { markdownResponse, SUPPORT_MARKDOWN } from "../agent-content";

export const GET: APIRoute = ({ request }) =>
  markdownResponse(SUPPORT_MARKDOWN, request.method);
