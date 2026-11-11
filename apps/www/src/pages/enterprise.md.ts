import type { APIRoute } from "astro";
import { markdownResponse } from "../agent-content";
import { ENTERPRISE_MARKDOWN } from "../enterprise";

export const GET: APIRoute = ({ request }) =>
  markdownResponse(ENTERPRISE_MARKDOWN, request.method);
