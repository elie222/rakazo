import { Trans, useLingui } from "@lingui/react/macro";
import type { ConnectionCatalogItem } from "@rakazo/contracts";
import { CONNECTION_LABEL_MAX_LENGTH } from "@rakazo/contracts";
import type { ConnectionOwnerChoice } from "@rakazo/core";
import { catalogItemAccounts, catalogItemKey, organizationConnectionForApp } from "@rakazo/core";
import { Button, FieldGroup, Input, Spinner } from "@rakazo/ui-web";
import { ChevronLeft, Plus } from "lucide-react";
import { useState } from "react";
import { ConnectionOwnerPicker } from "../../components/integrations/connection-owner-picker";
import { ChatAppLink } from "./parts";
import { ToolPermissions } from "./tool-permissions";
import type { PluginConnections } from "./use-plugin-connections";

/** A connected app's page: its accounts, adding another, its tools, and uninstalling it. */
export function ConnectorDetail({
  item,
  organizationName,
  state,
  onBack,
  onOpenChatApp,
}: {
  item: ConnectionCatalogItem;
  organizationName?: string | null;
  state: PluginConnections;
  onBack: () => void;
  onOpenChatApp?: () => void;
}) {
  const { t } = useLingui();
  const {
    connections,
    pending,
    labelDrafts,
    setLabelDrafts,
    tools,
    toolsLoading,
    toolsFailed,
    connect,
    revokeAccount,
    uninstall,
    renameAccount,
  } = state;
  const [owner, setOwner] = useState<ConnectionOwnerChoice>("me");
  const accounts = catalogItemAccounts(connections, item);
  const shared = accounts.some((row) => row.organization);
  const adding = !accounts.length && !item.connected;
  const offerOwnership = organizationConnectionForApp(connections, item.slug)
    ? null
    : organizationName;
  const key = catalogItemKey(item);
  const connecting = pending === key;
  const uninstalling = pending === `uninstall:${key}`;

  return (
    <div data-testid="connection-detail" className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label={t`Back`}
            onClick={onBack}
          >
            <ChevronLeft />
          </Button>
          {item.logo ? (
            <img
              src={item.logo}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-9 w-9 shrink-0 rounded-xl bg-accent object-contain"
            />
          ) : (
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-body font-semibold text-foreground">
              {Array.from(item.name)[0]}
            </div>
          )}
          <div className="truncate text-heading3 font-medium text-foreground">{item.name}</div>
        </div>
        {!shared && !adding ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={uninstalling || connecting}
            onClick={() => void uninstall(item)}
          >
            {uninstalling ? <Trans>Removing…</Trans> : <Trans>Uninstall</Trans>}
          </Button>
        ) : null}
      </div>

      <section data-testid="connection-accounts" className="space-y-1">
        {accounts.map((row) => (
          <div key={row.id} className="group/account flex items-center gap-2">
            <div className="min-w-0 flex-1">
              {row.manageable === false ? (
                <div className="truncate px-2 text-body">{row.displayName}</div>
              ) : (
                <Input
                  value={labelDrafts[row.id] ?? row.displayName}
                  aria-label={t`Account label`}
                  maxLength={CONNECTION_LABEL_MAX_LENGTH}
                  size="lg"
                  className="rounded-lg border-transparent bg-transparent px-2 text-body shadow-none hover:bg-accent/60 focus-visible:bg-background dark:bg-transparent"
                  onChange={(event) =>
                    setLabelDrafts((current) => ({
                      ...current,
                      [row.id]: event.target.value,
                    }))
                  }
                  onBlur={() => void renameAccount(row)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229) {
                      if (event.key === "Escape") event.stopPropagation();
                      return;
                    }
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                />
              )}
              {row.organization ? (
                <div className="px-2 text-body-sm text-muted-foreground">
                  <Trans>Organization</Trans>
                </div>
              ) : null}
            </div>
            {row.organization && row.status !== "connected" ? (
              row.manageable !== false ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={connecting}
                  onClick={() => connect(item, { reconnectId: row.id })}
                >
                  <Trans>Reconnect</Trans>
                </Button>
              ) : (
                <span className="text-body-sm text-muted-foreground">
                  <Trans>Needs sign-in</Trans>
                </span>
              )
            ) : null}
            {row.manageable !== false ? (
              <Button
                type="button"
                variant="ghost"
                className="shrink-0 px-2.5 text-label text-muted-foreground pointer-fine:opacity-0 pointer-fine:group-focus-within/account:opacity-100 pointer-fine:group-hover/account:opacity-100"
                disabled={pending === row.id || uninstalling}
                onClick={() => revokeAccount(row)}
              >
                {pending === row.id ? <Trans>Removing…</Trans> : <Trans>Remove</Trans>}
              </Button>
            ) : null}
          </div>
        ))}
        {offerOwnership ? (
          <FieldGroup className="px-2">
            <ConnectionOwnerPicker
              organizationName={offerOwnership}
              value={owner}
              onChange={setOwner}
            />
          </FieldGroup>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          className="px-2 text-body text-muted-foreground"
          size="lg"
          disabled={connecting || uninstalling}
          onClick={() => connect(item, offerOwnership ? owner : "me")}
        >
          <Plus />
          {connecting ? (
            <Trans>Adding…</Trans>
          ) : adding ? (
            <Trans>Connect</Trans>
          ) : (
            <Trans>Add another</Trans>
          )}
        </Button>
      </section>

      {toolsFailed ? (
        <p role="alert" className="px-2 text-body-sm text-destructive">
          <Trans>Could not load permissions</Trans>
        </p>
      ) : toolsLoading ? (
        <div className="px-2 text-muted-foreground">
          <Spinner aria-label={t`Loading tool permissions…`} />
        </div>
      ) : tools.length > 0 ? (
        <ToolPermissions tools={tools} slug={item.slug} />
      ) : null}

      {item.chatApp && onOpenChatApp ? (
        <p data-testid="chat-app-hint" className="px-2 text-body-sm">
          <ChatAppLink name={item.name} onOpen={onOpenChatApp} />
        </p>
      ) : null}
    </div>
  );
}
