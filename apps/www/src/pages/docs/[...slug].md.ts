import { getCollection } from "astro:content";
import type { APIRoute, GetStaticPaths } from "astro";
import { markdownResponse } from "../../agent-content";
import { DOCS_SLUGS } from "../../docs";

export const getStaticPaths = (async () =>
  (await getCollection("docs"))
    .filter((entry) => entry.id !== DOCS_SLUGS[0])
    .map((entry) => ({
      params: { slug: entry.id },
      props: { body: entry.body ?? "" },
    }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ body: string }> = ({ props, request }) =>
  markdownResponse(props.body, request.method);
