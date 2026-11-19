import type { APIRoute } from "astro";
import { agentInstructions, agentResourceGroups } from "../agent-index";

export const GET: APIRoute = async ({ request }) =>
  new Response(request.method === "HEAD" ? null : agentInstructions(await agentResourceGroups()), {
    headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Language": "en",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
