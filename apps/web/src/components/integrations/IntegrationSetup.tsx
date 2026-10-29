import { Trans, useLingui } from "@lingui/react/macro";
import type { IntegrationCatalogResult } from "@rakazo/contracts";
import { newClientId } from "@rakazo/core";
import { Button, Disclosure, Input } from "@rakazo/ui-web";
import { useState } from "react";
import { connectMcpOauth } from "../../lib/mcp-connect";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

/** Personal MCP connections never configure deployment-wide provider credentials. */
export function IntegrationSetup({ onDone, botId }: { onDone?: () => void; botId?: string }) {
  const { t } = useLingui();
  const [endpoint, setEndpoint] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<IntegrationCatalogResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<string[]>([]);
  const remoteResults = [
    ...new Map(
      results.flatMap((result) =>
        result.surfaces
          .filter((surface) => surface.kind === "mcp" && surface.source?.startsWith("https://"))
          .map(
            (surface) =>
              [surface.source!, { name: result.name, endpoint: surface.source! }] as const,
          ),
      ),
    ).values(),
  ];
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err, t`Could not connect`));
    } finally {
      setBusy(false);
    }
  }

  async function connect(name: string, url: string) {
    await run(async () => {
      const existing = (await rpc.mcp.servers.list()).find((server) => server.endpoint === url);
      const server =
        existing ??
        (await rpc.mcp.servers.create({
          slug: `integration-${newClientId().slice(0, 8)}`,
          name,
          transport: "streamable_http",
          endpoint: url,
        }));
      const result = await connectMcpOauth(server.id);
      if (result === "cancelled") return;
      if (botId) await rpc.mcp.assignments.approve({ botId, serverId: server.id });
      setConnected((current) => [...current, url]);
    });
  }

  return (
    <div className="space-y-6">
      <h1 className="text-[32px] font-medium text-foreground">
        <Trans>Add MCP server</Trans>
      </h1>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const response = await rpc.capabilities.catalogSearch({
              query,
              usePublicCatalog: true,
            });
            setResults(response.results);
            setSearched(true);
          });
        }}
      >
        <Input
          aria-label={t`Search apps`}
          placeholder={t`Search apps`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit" disabled={busy || !query.trim()}>
          <Trans>Search integrations.sh</Trans>
        </Button>
      </form>
      {remoteResults.map((result) => (
        <div key={result.endpoint} className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate">{result.name}</span>
          <Button
            variant="outline"
            disabled={busy || connected.includes(result.endpoint)}
            onClick={() => void connect(result.name, result.endpoint)}
          >
            {connected.includes(result.endpoint) ? t`Connected` : t`Connect`}
          </Button>
        </div>
      ))}
      {searched && !remoteResults.length ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No remote MCP servers found</Trans>
        </p>
      ) : null}
      <Disclosure className="text-sm text-muted-foreground" summary={<Trans>Add server URL</Trans>}>
        <div className="mt-3 space-y-3">
          <Input
            aria-label={t`Server URL`}
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder="https://example.com/mcp"
          />
          <Button
            disabled={busy || !endpoint.trim()}
            onClick={() => void connect("MCP server", endpoint.trim())}
          >
            <Trans>Connect</Trans>
          </Button>
        </div>
      </Disclosure>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {onDone ? (
        <Button disabled={busy} onClick={onDone}>
          <Trans>Continue</Trans>
        </Button>
      ) : null}
    </div>
  );
}
