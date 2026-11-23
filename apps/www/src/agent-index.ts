import { getCollection } from "astro:content";
import { getMarkdownAlternate } from "./agent-content";
import { DOCS_PAGES, docsPath } from "./docs";
import type { AgentResourceGroup } from "./marketing-site";
import { marketing } from "./marketing-site";
import { SITE_URL } from "./site";

const AGENT_INSTRUCTIONS_INTRO = `# Rakazo

> Open source AI teammates with sandboxed browser and shell access. Your keys, your model, your machine.

## Canonical resources

- [AI Catalog](https://rakazo.com/.well-known/ai-catalog.json): machine-readable index of the public agent resources.
- [Website](https://rakazo.com/): product overview, supported models, and common questions.
- [Website Markdown](https://rakazo.com/index.md): the English product overview as Markdown.
- [Docs](https://rakazo.com/docs/): getting started, using Rakazo, and self-hosting. Each page has a Markdown version.
- [Source](https://github.com/elie222/rakazo)
`;

function markdownPath(path: string): string {
  const markdown = getMarkdownAlternate(path);
  if (!markdown) throw new Error(`No Markdown twin for ${path}`);
  return markdown;
}

/** Every page with a Markdown twin that agents should be able to find, built from the page data. */
export async function agentResourceGroups(): Promise<AgentResourceGroup[]> {
  const docs = new Map(
    (await getCollection("docs")).map((entry) => [entry.id, entry.data.description]),
  );
  return [
    {
      id: "doc",
      heading: "Docs",
      resources: DOCS_PAGES.map((page) => ({
        id: page.slug,
        name: page.label,
        path: docsPath(page.slug),
        summary: docs.get(page.slug),
      })),
    },
    ...(await marketing.agentResourceGroups(getCollection)),
  ];
}

export function agentInstructions(groups: readonly AgentResourceGroup[]): string {
  return [
    marketing.agentInstructionsIntro ?? AGENT_INSTRUCTIONS_INTRO,
    ...groups.flatMap((group) => [
      `### ${group.heading}`,
      "",
      ...group.resources.map(
        (resource) =>
          `- [${resource.name}](${SITE_URL}${resource.path}) ([Markdown](${SITE_URL}${markdownPath(resource.path)}))${resource.summary ? `: ${resource.summary}` : ""}`,
      ),
      "",
    ]),
  ].join("\n");
}

export function aiCatalog(groups: readonly AgentResourceGroup[]) {
  return {
    specVersion: "1.0",
    host: {
      displayName: "Rakazo",
      documentationUrl: `${SITE_URL}${marketing.agentDocumentationPath ?? "/docs/"}`,
    },
    entries: [
      {
        identifier: "urn:air:rakazo.com:docs:llms",
        displayName: "Rakazo agent guide",
        type: "text/plain",
        url: `${SITE_URL}/llms.txt`,
        description: "Product overview, agent-assisted setup guidance, and canonical resources.",
      },
      {
        identifier: "urn:air:rakazo.com:docs:overview",
        displayName: "Rakazo overview",
        type: "text/markdown",
        url: `${SITE_URL}/index.md`,
        description: "Features, model choices, self-hosting, and common questions.",
      },
      ...marketing.agentCatalogEntries,
      ...groups.flatMap((group) =>
        group.resources.map((resource) => ({
          identifier: `urn:air:rakazo.com:${group.id}:${resource.id}`,
          displayName: resource.name,
          type: "text/markdown",
          url: `${SITE_URL}${markdownPath(resource.path)}`,
          ...(resource.summary ? { description: resource.summary } : {}),
        })),
      ),
    ],
  };
}
