import type { APIRoute } from "astro";
import { markdownResponse } from "../../agent-content";
import { SANDBOXES, sandboxMarkdown } from "../../sandboxes";

export function getStaticPaths() {
  return SANDBOXES.map((sandbox) => ({
    params: { slug: sandbox.slug },
    props: { body: sandboxMarkdown(sandbox) },
  }));
}

export const GET: APIRoute = ({ props, request }) =>
  markdownResponse((props as { body: string }).body, request.method);
