import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { markdownResponse } from "../agent-content";
import { blogIndexMarkdown } from "../blog/markdown";

export const GET: APIRoute = async ({ request }) =>
  markdownResponse(blogIndexMarkdown(await getCollection("blog")), request.method);
