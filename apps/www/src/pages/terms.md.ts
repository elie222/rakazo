import type { APIRoute } from "astro";
import { markdownResponse, TERMS_MARKDOWN } from "../agent-content";

export const GET: APIRoute = ({ request }) =>
  markdownResponse(TERMS_MARKDOWN, request.method);
