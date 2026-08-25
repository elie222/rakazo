import type { APIRoute } from "astro";
import { AGENT_INSTRUCTIONS } from "../agent-content";

export const GET: APIRoute = ({ request }) =>
  new Response(request.method === "HEAD" ? null : AGENT_INSTRUCTIONS, {
    headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Language": "en",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
