import type { APIRoute } from "astro";
import { markdownResponse } from "../agent-content";
import { ALTERNATIVES, alternativeMarkdown } from "../alternatives";

export function getStaticPaths() {
  return ALTERNATIVES.map((page) => ({
    params: { slug: page.slug },
    props: { body: alternativeMarkdown(page) },
  }));
}

export const GET: APIRoute = ({ props, request }) =>
  markdownResponse((props as { body: string }).body, request.method);
