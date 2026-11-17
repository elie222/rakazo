import type { APIRoute } from "astro";
import { markdownResponse } from "../agent-content";
import { roundupMarkdown } from "../roundup";

export const GET: APIRoute = ({ request }) => markdownResponse(roundupMarkdown(), request.method);
