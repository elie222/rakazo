import type { APIRoute } from "astro";
import { markdownResponse, PRIVACY_MARKDOWN } from "../agent-content";

export const GET: APIRoute = ({ request }) =>
  markdownResponse(PRIVACY_MARKDOWN, request.method);
