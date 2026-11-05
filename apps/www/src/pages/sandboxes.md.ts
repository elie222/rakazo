import type { APIRoute } from "astro";
import { markdownResponse } from "../agent-content";
import { sandboxesHubMarkdown } from "../sandboxes";

export const GET: APIRoute = ({ request }) =>
  markdownResponse(sandboxesHubMarkdown(), request.method);
