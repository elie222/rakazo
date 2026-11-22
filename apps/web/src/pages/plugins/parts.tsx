import { Trans, useLingui } from "@lingui/react/macro";
import type {
  ConnectionCatalogItem,
  McpServer,
  McpServerConnection,
  PluginMarketplaceEntry,
} from "@rakazo/contracts";
import { mcpServerConnection } from "@rakazo/contracts";
import { catalogItemKey } from "@rakazo/core";
import { Button, SectionHeading } from "@rakazo/ui-web";
import { Check, ChevronLeft, CircleAlert, TriangleAlert } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { ROW_BUTTON, ROW_HOVER, ROW_SHELL } from "../../components/integrations/plugin-marketplace";
import type { PluginConnections } from "./use-plugin-connections";

export function ConnectorIcon({ name, logo }: { name: string; logo?: string | null }) {
  return logo ? (
    <img
      src={logo}
      alt=""
      loading="lazy"
      decoding="async"
      className="h-9 w-9 shrink-0 rounded-xl bg-accent object-contain"
    />
  ) : (
    <div
      aria-hidden="true"
      className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-body font-semibold text-foreground"
    >
      {Array.from(name)[0]}
    </div>
  );
}

function connectionLabel(state: McpServerConnection): ReactElement {
  switch (state) {
    case "disabled":
      return <Trans>Disabled</Trans>;
    case "needs_client":
      return <Trans>Needs an OAuth client ID</Trans>;
    case "needs_sign_in":
      return <Trans>Needs sign-in</Trans>;
    case "not_working":
      return <Trans>Not working</Trans>;
    case "connected":
      return <Trans>Connected</Trans>;
    case "not_connected":
      return <Trans>Not connected</Trans>;
  }
}

export function ConnectionStatus({ server }: { server: McpServer }) {
  const state = mcpServerConnection(server);
  const warning = state === "needs_sign_in" || state === "needs_client";
  const Icon =
    state === "connected"
      ? Check
      : warning
        ? TriangleAlert
        : state === "not_working"
          ? CircleAlert
          : null;
  const tone =
    state === "connected"
      ? "text-success"
      : warning
        ? "text-warning"
        : state === "not_working"
          ? "text-destructive"
          : "text-muted-foreground";
  return (
    <span className={`flex min-w-0 items-center gap-1 text-body-sm ${tone}`}>
      {Icon ? <Icon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
      <span className="truncate">{connectionLabel(state)}</span>
    </span>
  );
}

/** A sub-view's heading with its back button. */
export function ViewTitle({ title, onBack }: { title: ReactNode; onBack: () => void }) {
  const { t } = useLingui();
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="-ms-2 text-muted-foreground"
        aria-label={t`Back`}
        onClick={onBack}
      >
        <ChevronLeft />
      </Button>
      <SectionHeading as="h2" variant="heading">
        {title}
      </SectionHeading>
    </div>
  );
}

/** What every catalog tile needs to read and act on its app. */
export type TileContext = {
  connections: PluginConnections;
  /** Managed apps whose brand also has a plugin, keyed by catalog item. */
  pluginForApp: Map<string, PluginMarketplaceEntry>;
  onOpenApp: (item: ConnectionCatalogItem) => void;
  onOpenDetail: (item: ConnectionCatalogItem) => void;
  /** Opens where a chat app is set up; absent where that cannot be reached. */
  onOpenChatApp?: () => void;
};

/** An app in the catalog with its Add or Added button; a connected app opens its page. */
export function CatalogTile({
  item,
  label,
  logo,
  tileTestId: tileTestIdOption,
  context,
}: {
  item: ConnectionCatalogItem;
  label: string;
  logo?: string | null;
  tileTestId?: boolean;
  context: TileContext;
}) {
  const { connections, pluginForApp, onOpenApp, onOpenChatApp } = context;
  const connected = connections.itemConnected(item);
  const openable = connected || pluginForApp.has(catalogItemKey(item));
  const tileTestId = tileTestIdOption !== false && connected;
  const icon = <ConnectorIcon name={label} logo={logo} />;
  const title = (
    <div className="min-w-0 flex-1 text-start">
      <div className="truncate text-body-lg font-medium text-foreground">{label}</div>
    </div>
  );
  const tile = (
    <div
      data-testid={tileTestId ? `connection-tile-${item.slug.toLowerCase()}` : undefined}
      className={`${ROW_SHELL} self-start${openable ? ` ${ROW_HOVER}` : ""}`}
    >
      {openable ? (
        <button type="button" className={ROW_BUTTON} onClick={() => onOpenApp(item)}>
          {icon}
          {title}
        </button>
      ) : (
        <>
          {icon}
          {title}
        </>
      )}
      <CatalogActions item={item} label={label} context={context} />
    </div>
  );
  // Before connecting is when the two are mixed up; a connected app says it on its page.
  if (!item.chatApp || connected || !onOpenChatApp) return tile;
  return (
    <div className="min-w-0">
      {tile}
      <p
        data-testid="chat-app-hint"
        className="-mt-1.5 flex flex-wrap gap-x-1.5 ps-14.5 pe-2.5 pb-2 text-body-sm text-muted-foreground"
      >
        <Trans>Tools for your bot.</Trans>
        <ChatAppLink name={label} onOpen={onOpenChatApp} />
      </p>
    </div>
  );
}

/** Leads from an app's tools to messaging the bot from that app. */
export function ChatAppLink({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="rounded-sm text-foreground underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      onClick={onOpen}
    >
      <Trans>Chat from {name}</Trans>
    </button>
  );
}

function CatalogActions({
  item,
  label,
  context,
}: {
  item: ConnectionCatalogItem;
  label: string;
  context: TileContext;
}) {
  const { t } = useLingui();
  const { connections, onOpenDetail } = context;
  const key = catalogItemKey(item);
  const connected = connections.itemConnected(item);
  const connecting = connections.pending === key;
  if (connected) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={connecting}
        onClick={(event) => {
          event.stopPropagation();
          onOpenDetail(item);
        }}
      >
        {connecting ? <Trans>Adding…</Trans> : <Trans>Added</Trans>}
      </Button>
    );
  }
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      aria-label={connecting ? undefined : t`Add ${label}`}
      disabled={connecting}
      onClick={(event) => {
        event.stopPropagation();
        void connections.connect(item);
      }}
    >
      {connecting ? <Trans>Adding…</Trans> : <Trans>Add</Trans>}
    </Button>
  );
}
