import type { APIRoute } from "astro";
import { ABOUT_MARKDOWN, markdownResponse } from "../agent-content";

export const GET: APIRoute = ({ request }) =>
  markdownResponse(ABOUT_MARKDOWN, request.method);
