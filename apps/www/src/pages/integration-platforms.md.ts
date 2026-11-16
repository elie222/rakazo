import type { APIRoute } from "astro";
import { markdownResponse } from "../agent-content";
import { integrationPlatformsHubMarkdown } from "../integration-platforms";

export const GET: APIRoute = ({ request }) =>
  markdownResponse(integrationPlatformsHubMarkdown(), request.method);
