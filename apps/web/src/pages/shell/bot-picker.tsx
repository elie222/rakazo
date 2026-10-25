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
import { IconTooltip } from "../../components/IconTooltip";

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
      <Command
        shouldFilter={false}
        className="h-auto max-h-(--available-height) rounded-none border-0 bg-transparent p-0"
      >
        <label className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
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
        <CommandList className="flex min-h-0 max-h-none flex-col overflow-hidden p-1 [&>[cmdk-list-sizer]]:flex [&>[cmdk-list-sizer]]:min-h-0 [&>[cmdk-list-sizer]]:flex-col">
          <CommandEmpty>
            <Trans>No bots match</Trans>
          </CommandEmpty>
          <CommandGroup className="shrink-0">
            {showCreate ? (
              <CommandItem
                value="create-new-bot"
                data-testid="create-new-bot"
                onSelect={() => onCreateBot()}
                className="gap-2"
              >
                <span className="flex size-[22px] shrink-0 items-center justify-center">
                  <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
                </span>
                <Trans>Create new Bot</Trans>
              </CommandItem>
            ) : null}
            <CommandItem
              value="create-group"
              data-testid="create-new-group"
              onSelect={() => onCreateGroup()}
              className="gap-2"
            >
              <span className="flex size-[22px] shrink-0 items-center justify-center">
                <Users size={16} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1 truncate">
                <Trans>Create new Group</Trans>
              </span>
              <PickerInfoButton
                testId="picker-info-group"
                label={t`About groups`}
                onClick={onShowGroupInfo}
              />
            </CommandItem>
            <CommandItem
              value="create-space"
              data-testid="create-new-space"
              onSelect={() => onCreateSpace()}
              className="gap-2"
            >
              <span className="flex size-[22px] shrink-0 items-center justify-center">
                <Lock size={16} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1 truncate">
                <Trans>Create new Space</Trans>
              </span>
              <PickerInfoButton
                testId="picker-info-space"
                label={t`About spaces`}
                onClick={onShowSpaceInfo}
              />
            </CommandItem>
          </CommandGroup>
          <CommandSeparator className="shrink-0" />
          <CommandGroup className="min-h-0 max-h-60 overflow-y-auto">
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
        </CommandList>
      </Command>
    </div>
  );
}

/** Opens an explainer from inside a command row without selecting the row. */
function PickerInfoButton({
  testId,
  label,
  onClick,
}: {
  testId: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <IconTooltip label={label}>
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          onClick();
        }}
        onKeyDown={(event) => event.stopPropagation()}
        className="-mr-2 shrink-0 rounded p-1 text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-focus-within/command-item:opacity-100 group-hover/command-item:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Info size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </IconTooltip>
  );
}
