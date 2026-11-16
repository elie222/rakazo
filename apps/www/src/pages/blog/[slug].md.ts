import { getCollection } from "astro:content";
import type { APIRoute, GetStaticPaths } from "astro";
import { markdownResponse } from "../../agent-content";
import { blogPostMarkdown } from "../../blog/markdown";

export const getStaticPaths = (async () =>
  (await getCollection("blog")).map((post) => ({
    params: { slug: post.id },
    props: { body: blogPostMarkdown(post) },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ body: string }> = ({ props, request }) =>
  markdownResponse(props.body, request.method);
