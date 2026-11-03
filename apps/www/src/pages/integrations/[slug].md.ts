import type { APIRoute, GetStaticPaths } from "astro";
import { markdownResponse } from "../../agent-content";
import type { Integration } from "../../integrations";
import { INTEGRATIONS, integrationMarkdown, integrationUrlSlug } from "../../integrations";

export const getStaticPaths = (() =>
  INTEGRATIONS.map((integration) => ({
    params: { slug: integrationUrlSlug(integration.slug) },
    props: { integration },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ integration: Integration }> = ({ props, request }) =>
  markdownResponse(integrationMarkdown(props.integration), request.method);
