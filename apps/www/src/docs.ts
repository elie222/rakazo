export const DOCS_PATH = "/docs/";

export const DOCS_NAV = [
  { title: "Get started", pages: [{ slug: "getting-started", label: "Getting started" }] },
  {
    title: "Using Rakazo",
    pages: [
      { slug: "bot-secrets", label: "Reusable credentials" },
      { slug: "fleet-management", label: "Bots that manage bots" },
      { slug: "import-an-agent", label: "Import an agent" },
    ],
  },
  {
    title: "Self-hosting",
    pages: [
      { slug: "self-host", label: "Overview" },
      { slug: "self-host-secrets", label: "Secrets" },
      { slug: "self-host-sandbox-providers", label: "Computer providers" },
      { slug: "self-host-restricted-network", label: "Restricted networks" },
      { slug: "computer-runtime", label: "Computer runtime" },
    ],
  },
] as const;

export const DOCS_PAGES: { slug: string; label: string }[] = DOCS_NAV.flatMap((section) => [
  ...section.pages,
]);

export const DOCS_SLUGS = DOCS_PAGES.map((page) => page.slug);

export function docsPath(slug: string): string {
  return slug === DOCS_SLUGS[0] ? DOCS_PATH : `${DOCS_PATH}${slug}/`;
}
