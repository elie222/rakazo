import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import {
  BotAvatar,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@rakazo/ui-web";
import { Info, Lock, Plus, Users } from "lucide-react";
import { useMemo, useState } from "react";

export function BotCreatePicker({
  bots,
  onCreateBot,
  onOpenBot,
  onCreateGroup,
  onCreateSpace,
  onShowGroupInfo,
  onShowSpaceInfo,
}: {
  bots: Bot[];
  onCreateBot: () => void;
  onOpenBot: (botId: string) => void;
  onCreateGroup: () => void;
  onCreateSpace: () => void;
  onShowGroupInfo: () => void;
  onShowSpaceInfo: () => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matched = useMemo(() => {
    if (!needle) return bots;
    return bots.filter(
      (bot) => bot.name.toLowerCase().includes(needle) || bot.title.toLowerCase().includes(needle),
    );
  }, [bots, needle]);
  const showCreate =
    !needle ||
    "create new bot".includes(needle) ||
    needle.split(/\s+/).every((part) => "create new bot".includes(part));

  return (
    <div data-testid="bot-create-picker" className="w-[min(320px,calc(100vw-2rem))]">
      <label className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="shrink-0 text-[13px] text-muted-foreground">
          <Trans>To:</Trans>
        </span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t`Search`}
          aria-label={t`Search`}
          className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </label>
      <Command shouldFilter={false} className="rounded-none border-0 bg-transparent p-0">
        <CommandList className="max-h-72 p-1">
          <CommandEmpty>
            <Trans>No bots match</Trans>
          </CommandEmpty>
          <CommandGroup>
            {showCreate ? (
              <CommandItem
                value="create-new-bot"
                data-testid="create-new-bot"
                onSelect={() => onCreateBot()}
                className="gap-2"
              >
                <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
                <Trans>Create new Bot</Trans>
              </CommandItem>
            ) : null}
            {matched.map((bot) => (
              <CommandItem
                key={bot.id}
                value={bot.id}
                data-testid={`picker-bot-${bot.id}`}
                onSelect={() => onOpenBot(bot.id)}
                className="gap-2"
              >
                <BotAvatar color={bot.color} identity={bot.id} size={22} status={bot.status} />
                <span className="min-w-0 flex-1 truncate">{bot.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup>
            <CommandItem
              value="create-group"
              data-testid="create-new-group"
              onSelect={() => onCreateGroup()}
              className="gap-2"
            >
              <Users size={16} strokeWidth={1.8} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">
                <Trans>Create new Group</Trans>
              </span>
              <button
                type="button"
                data-testid="picker-info-group"
                aria-label={t`About groups`}
                title={t`About groups`}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  onShowGroupInfo();
                }}
                onKeyDown={(event) => event.stopPropagation()}
                className="-mr-2 shrink-0 rounded p-1 text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-focus-within/command-item:opacity-100 group-hover/command-item:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <Info size={14} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </CommandItem>
            <CommandItem
              value="create-space"
              data-testid="create-new-space"
              onSelect={() => onCreateSpace()}
              className="gap-2"
            >
              <Lock size={14} strokeWidth={1.8} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">
                <Trans>Create new Space</Trans>
              </span>
              <button
                type="button"
                data-testid="picker-info-space"
                aria-label={t`About spaces`}
                title={t`About spaces`}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  onShowSpaceInfo();
                }}
                onKeyDown={(event) => event.stopPropagation()}
                className="-mr-2 shrink-0 rounded p-1 text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-focus-within/command-item:opacity-100 group-hover/command-item:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <Info size={14} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}
