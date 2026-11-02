export const DOCS_PATH = "/docs/";

type DocsSection = {
  title: string;
  /** `slug` is the path of `docs/<slug>.md`; the first page of the first section is `/docs/`. */
  pages: readonly { slug: string; label: string }[];
};

export const DOCS_NAV = [
  {
    title: "Get started",
    pages: [
      { slug: "getting-started", label: "Getting started" },
      { slug: "bots-and-chats", label: "Bots and chats" },
      { slug: "import-an-agent", label: "Import an agent" },
    ],
  },
  {
    title: "Using Rakazo",
    pages: [
      { slug: "integrations", label: "Connect apps" },
      { slug: "routines", label: "Routines" },
      { slug: "computer", label: "The bot's computer" },
      { slug: "memory", label: "Memory" },
      { slug: "skills", label: "Skills" },
      { slug: "approvals", label: "Approvals" },
      { slug: "groups", label: "Groups and teamwork" },
      { slug: "voice-and-calls", label: "Voice and calls" },
      { slug: "messaging-apps", label: "Chat apps" },
    ],
  },
  {
    title: "Settings",
    pages: [
      { slug: "models", label: "Models" },
      { slug: "spaces", label: "Spaces" },
      { slug: "bot-secrets", label: "Reusable credentials" },
      { slug: "account", label: "Account and billing" },
    ],
  },
  {
    title: "Apps",
    pages: [
      { slug: "desktop-app", label: "Desktop app" },
      { slug: "mobile-app", label: "Mobile app" },
    ],
  },
  {
    title: "Advanced",
    pages: [
      { slug: "fleet-management", label: "Bots that manage bots" },
      { slug: "build-a-plugin", label: "Build a plugin" },
    ],
  },
  {
    title: "Self-hosting",
    pages: [
      { slug: "self-host", label: "Overview" },
      { slug: "self-host-configuration", label: "Configuration" },
      { slug: "self-host-secrets", label: "Secrets" },
      { slug: "self-host-production", label: "Production deployment" },
      { slug: "self-host-upgrading", label: "Upgrading" },
      { slug: "self-host-backups", label: "Backup and restore" },
    ],
  },
  {
    title: "Configure your server",
    pages: [
      { slug: "self-host-accounts", label: "Sign-in and accounts" },
      { slug: "self-host-models", label: "Models" },
      { slug: "self-host-integrations", label: "Tools and integrations" },
      { slug: "self-host-sandbox-providers", label: "Computer providers" },
      { slug: "self-host-docker-computers", label: "Docker computers" },
      { slug: "computer-runtime", label: "Computer runtime" },
      { slug: "self-host-storage", label: "Storage and encryption" },
      { slug: "self-host-clients", label: "Apps and clients" },
      { slug: "self-host-billing", label: "Billing" },
      { slug: "self-host-observability", label: "Logs and monitoring" },
      { slug: "self-host-restricted-network", label: "Restricted networks" },
    ],
  },
] as const satisfies readonly DocsSection[];

export const DOCS_PAGES: { slug: string; label: string; section: string }[] = DOCS_NAV.flatMap(
  (section) => section.pages.map((page) => ({ ...page, section: section.title })),
);

export const DOCS_SLUGS = DOCS_PAGES.map((page) => page.slug);

export function docsPath(slug: string): string {
  return slug === DOCS_SLUGS[0] ? DOCS_PATH : `${DOCS_PATH}${slug}/`;
}
