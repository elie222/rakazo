import type { APIRoute } from "astro";
import { roundupMarkdown } from "../roundup";
import { markdownResponse } from "../agent-content";

export const GET: APIRoute = ({ request }) =>
  markdownResponse(roundupMarkdown(), request.method);
