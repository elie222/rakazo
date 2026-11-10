import type { APIRoute } from "astro";
import { DOWNLOAD_MARKDOWN, markdownResponse } from "../agent-content";

export const GET: APIRoute = ({ request }) =>
  markdownResponse(DOWNLOAD_MARKDOWN, request.method);
