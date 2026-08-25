import type { APIRoute } from "astro";
import { markdownResponse, NOT_FOUND_MARKDOWN } from "../agent-content";

export const GET: APIRoute = ({ request }) =>
  markdownResponse(NOT_FOUND_MARKDOWN, request.method, 404);
