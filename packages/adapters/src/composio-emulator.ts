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

const DEFAULT_CATALOG: ReadonlyArray<Omit<ComposioCatalogItem, "connected">> = [
  { slug: "GMAIL", name: "Gmail", logo: null, noAuth: false },
  { slug: "SLACK", name: "Slack", logo: null, noAuth: false },
  { slug: "GITHUB", name: "GitHub", logo: null, noAuth: false },
  { slug: "NOTION", name: "Notion", logo: null, noAuth: false },
];

/** Deterministic, offline Composio catalog and connection emulator for product tests. */
export class ComposioEmulator implements ComposioProvider {
  private readonly connectedByUser = new Map<string, Set<string>>();

  constructor(
    private readonly directory: ReadonlyArray<
      Omit<ComposioCatalogItem, "connected">
    > = DEFAULT_CATALOG,
  ) {}

  describe() {
    return {
      id: "composio-emulator",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }

  async catalog(userId: string, query?: string): Promise<ComposioCatalogItem[]> {
    const connected = this.connectedByUser.get(userId) ?? new Set<string>();
    return filterCatalog(
      this.directory.map((item) => ({ ...item, connected: connected.has(item.slug) })),
      query ?? "",
    );
  }

  async warmDirectory(): Promise<void> {}

  async listConnectedSlugs(userId: string): Promise<string[]> {
    return [...(this.connectedByUser.get(userId) ?? [])];
  }

  async discoverTools(_context: AdapterContext): Promise<ConnectorTool[]> {
    return [];
  }

  async *execute(call: ConnectorCall, _context: AdapterContext): AsyncIterable<ConnectorEvent> {
    yield { type: "error", message: `Composio emulator cannot execute ${call.tool}` };
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

  async connectionReady(userId: string, slug: string): Promise<boolean> {
    return this.connectedByUser.get(userId)?.has(slug) ?? false;
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
}
