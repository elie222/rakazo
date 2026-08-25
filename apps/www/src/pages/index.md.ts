import type { APIRoute } from "astro";
import { HOME_MARKDOWN, markdownResponse } from "../agent-content";

export const GET: APIRoute = ({ request }) =>
  markdownResponse(HOME_MARKDOWN, request.method);
