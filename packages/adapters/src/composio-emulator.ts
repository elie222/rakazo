import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import {
  type ComposioCatalogItem,
  type ComposioProvider,
  filterCatalog,
} from "./composio-connector.js";
import {
  DEFAULT_RAKAZO_EMULATED_RELEASES,
  type EmulatedGithubRelease,
  RELEASE_WATCH_GITHUB_TOOL_NAMES,
} from "./release-watch.js";

const DEFAULT_CATALOG: ReadonlyArray<Omit<ComposioCatalogItem, "connected">> = [
  { slug: "GMAIL", name: "Gmail", logo: null, noAuth: false },
  { slug: "GOOGLECALENDAR", name: "Google Calendar", logo: null, noAuth: false },
  { slug: "GOOGLEDRIVE", name: "Google Drive", logo: null, noAuth: false },
  { slug: "SLACK", name: "Slack", logo: null, noAuth: false },
  { slug: "GITHUB", name: "GitHub", logo: null, noAuth: false },
  { slug: "NOTION", name: "Notion", logo: null, noAuth: false },
];

/** Deterministic, offline Composio catalog and connection emulator for product tests. */
export class ComposioEmulator implements ComposioProvider {
  private readonly connectedByUser = new Map<string, Set<string>>();
  private githubReleases: EmulatedGithubRelease[] = [...DEFAULT_RAKAZO_EMULATED_RELEASES];
  readonly executions: Array<{
    userId: string;
    botId?: string;
    runId?: string;
    tool: string;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }> = [];

  constructor(
    private readonly directory: ReadonlyArray<
      Omit<ComposioCatalogItem, "connected">
    > = DEFAULT_CATALOG,
  ) {}

  /** Replace seeded GitHub releases (no live GitHub OAuth). */
  seedGithubReleases(releases: readonly EmulatedGithubRelease[]): void {
    this.githubReleases = [...releases];
  }

  listGithubReleases(): readonly EmulatedGithubRelease[] {
    return this.githubReleases;
  }

  describe() {
    return {
      id: "composio",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }

  async catalog(context: AdapterContext, query?: string) {
    const connected = this.connectedByUser.get(context.userId) ?? new Set<string>();
    return filterCatalog(
      this.directory.map((item) => ({ ...item, connected: connected.has(item.slug) })),
      query ?? "",
    ).map((item) => ({ ...item, connectorId: "composio" }));
  }

  async warmDirectory(): Promise<void> {}

  async listConnectedSlugs(userId: string): Promise<string[]> {
    return [...(this.connectedByUser.get(userId) ?? [])];
  }

  async listConnectedExternalIds(context: AdapterContext): Promise<string[]> {
    return this.listConnectedSlugs(context.userId);
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const connected =
      context.connectedConnections
        ?.filter((connection) => connection.connectorId === "composio")
        .map((connection) => connection.externalId) ??
      context.connectedProviders ??
      [];
    const tools: ConnectorTool[] = [];
    for (const slug of new Set(connected)) {
      if (slug === "GITHUB") {
        tools.push(...githubReleaseTools());
        continue;
      }
      tools.push({
        name: `${slug}_EMULATED_ACTION`,
        description: `Run a deterministic ${slug} action`,
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      });
    }
    return tools;
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    const result =
      (RELEASE_WATCH_GITHUB_TOOL_NAMES as readonly string[]).includes(call.tool) ||
      call.tool === "GITHUB_EMULATED_ACTION"
        ? this.executeGithub(call.tool, call.args)
        : { ok: true, tool: call.tool, args: call.args };
    this.executions.push({
      userId: context.userId,
      botId: context.botId,
      runId: context.runId,
      tool: call.tool,
      args: call.args,
      result,
    });
    yield { type: "result", data: result };
  }

  async begin(
    request: { provider: string; redirectUrl: string },
    context: AdapterContext,
  ): Promise<{ authorizationUrl: string | null; state: string }> {
    const connected = this.connectedByUser.get(context.userId) ?? new Set<string>();
    connected.add(request.provider);
    this.connectedByUser.set(context.userId, connected);
    return { authorizationUrl: null, state: request.provider };
  }

  async connectionReady(context: AdapterContext, slug: string): Promise<boolean> {
    return this.connectedByUser.get(context.userId)?.has(slug) ?? false;
  }

  async complete(
    request: { state: string; code?: string },
    _context: AdapterContext,
  ): Promise<{ connectionRef: string }> {
    return { connectionRef: request.state };
  }

  async revoke(connectionRef: string, context: AdapterContext): Promise<void> {
    this.connectedByUser.get(context.userId)?.delete(connectionRef);
  }

  private executeGithub(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    const owner = String(args.owner ?? args.owner_name ?? "elie222");
    const repo = String(args.repo ?? args.repository ?? "rakazo");
    const matched = this.githubReleases.filter(
      (release) =>
        release.owner.toLowerCase() === owner.toLowerCase() &&
        release.repo.toLowerCase() === repo.toLowerCase(),
    );
    if (tool === "GITHUB_LIST_RELEASES" || tool === "GITHUB_EMULATED_ACTION") {
      return {
        ok: true,
        tool,
        owner,
        repo,
        releases: matched.map((release) => ({
          tag: release.tag,
          name: release.name,
          body: release.body,
          publishedAt: release.publishedAt,
          htmlUrl: release.htmlUrl,
        })),
      };
    }
    if (tool === "GITHUB_GET_RELEASE") {
      const tag = args.tag ? String(args.tag) : undefined;
      const release = tag
        ? matched.find((row) => row.tag === tag)
        : [...matched].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
      if (!release) {
        return { ok: false, tool, error: `No release found for ${owner}/${repo}` };
      }
      return { ok: true, tool, release };
    }
    return { ok: false, tool, error: `unknown GitHub tool ${tool}` };
  }
}

function githubReleaseTools(): ConnectorTool[] {
  return [
    {
      name: "GITHUB_LIST_RELEASES",
      description:
        "List releases for a GitHub repository (owner + repo). Prefer this over browsing github.com or web search when GitHub is connected.",
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Repository owner, e.g. elie222" },
          repo: { type: "string", description: "Repository name, e.g. rakazo" },
        },
        required: ["owner", "repo"],
      },
    },
    {
      name: "GITHUB_GET_RELEASE",
      description:
        "Get one GitHub release by tag for owner/repo, or the latest release when tag is omitted. Prefer this over a computer browser.",
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          tag: { type: "string", description: "Release tag; omit for latest." },
        },
        required: ["owner", "repo"],
      },
    },
  ];
}
