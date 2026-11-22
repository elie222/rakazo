import { Trans } from "@lingui/react/macro";
import type { SearchHit } from "@rakazo/contracts";
import { searchHitListKey } from "@rakazo/core";
import { searchKindLabel } from "@rakazo/i18n/search";
import { Button, ContextMenuTrigger } from "@rakazo/ui-web";
import { Fragment } from "react";
import type { ChatMenuState, ChatMenuTarget } from "../shell/chat/chat-context-menu";
import { ChatMenu } from "../shell/chat/chat-context-menu";

export function SpaceSearchResults({
  hits,
  loading,
  error,
  onRetry,
  onSelect,
  chatMenu,
}: {
  hits: SearchHit[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onSelect: (hit: SearchHit) => void;
  /** Gives bot and group results the roster's right-click menu. */
  chatMenu?: ChatMenuState;
}) {
  // Loading and empty share one status region, so its text change is announced.
  if (loading) {
    return (
      <div role="status" className="px-3 py-4 text-body text-muted-foreground">
        <Trans>Searching…</Trans>
      </div>
    );
  }
  if (error) {
    return (
      <div className="px-3 py-4">
        <p role="alert" className="text-body text-destructive">
          {error}
        </p>
        <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  }
  if (!hits.length) {
    return (
      <div role="status" className="px-3 py-4 text-body text-muted-foreground">
        <Trans>No results</Trans>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {hits.map((hit) => {
        const key = searchHitListKey(hit);
        const row = (
          <button
            type="button"
            onClick={() => onSelect(hit)}
            className="rounded-xl px-2.5 py-[11px] text-start hover:bg-sidebar-accent"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-body-lg font-medium text-foreground" dir="auto">
                {hit.title}
              </span>
              <span className="shrink-0 text-label uppercase tracking-wide text-muted-foreground/80">
                {searchKindLabel(hit)}
              </span>
            </div>
            <div
              className="mt-0.5 flex min-w-0 gap-2 text-body-sm text-muted-foreground"
              dir="auto"
            >
              <span className="max-w-[40%] shrink-0 truncate text-foreground/75">
                {hit.groupName ?? hit.botName}
              </span>
              <span className="truncate">{hit.snippet}</span>
            </div>
          </button>
        );
        const chat = searchHitChat(hit);
        if (!chatMenu || !chat || !chatMenu.has(chat)) return <Fragment key={key}>{row}</Fragment>;
        return (
          <ChatMenu key={key} target={chat} state={chatMenu}>
            <ContextMenuTrigger
              render={row}
              // Focus the result so closing the menu returns focus here.
              onContextMenu={(event) => event.currentTarget.focus()}
            />
          </ChatMenu>
        );
      })}
    </div>
  );
}

function searchHitChat(hit: SearchHit): ChatMenuTarget | null {
  if (hit.kind !== "conversation") return null;
  if (hit.groupId) return { kind: "group", id: hit.groupId };
  return hit.botId ? { kind: "bot", id: hit.botId } : null;
}
