import type { APIRoute } from "astro";
import { agentResourceGroups, aiCatalog } from "../../agent-index";

export const GET: APIRoute = async () =>
  new Response(`${JSON.stringify(aiCatalog(await agentResourceGroups()), null, 2)}\n`, {
    headers: { "Content-Type": "application/ai-catalog+json" },
  });
