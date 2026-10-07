import type { APIRoute } from "astro";
import { ALTERNATIVES, alternativeMarkdown } from "../alternatives";
import { markdownResponse } from "../agent-content";

export function getStaticPaths() {
  return ALTERNATIVES.map((page) => ({
    params: { slug: page.slug },
    props: { body: alternativeMarkdown(page) },
  }));
}

export const GET: APIRoute = ({ props, request }) =>
  markdownResponse((props as { body: string }).body, request.method);
