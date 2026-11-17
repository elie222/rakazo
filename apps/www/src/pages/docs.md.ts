import { getEntry } from "astro:content";
import type { APIRoute } from "astro";
import { markdownResponse } from "../agent-content";
import { DOCS_SLUGS } from "../docs";

export const GET: APIRoute = async ({ request }) =>
  markdownResponse((await getEntry("docs", DOCS_SLUGS[0]))?.body ?? "", request.method);
