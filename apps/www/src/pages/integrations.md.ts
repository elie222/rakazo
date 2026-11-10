import type { APIRoute } from "astro";
import { markdownResponse } from "../agent-content";
import { integrationsMarkdown } from "../integrations";

export const GET: APIRoute = ({ request }) =>
  markdownResponse(integrationsMarkdown(), request.method);
