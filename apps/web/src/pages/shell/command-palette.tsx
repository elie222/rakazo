import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import {
  Badge,
  BotAvatar,
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
  Kbd,
} from "@rakazo/ui-web";
import { Check } from "lucide-react";
import type { ComponentType } from "react";
import { useEffect, useMemo, useState } from "react";

export type CommandPaletteAction = {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean }>;
  checked?: boolean;
  onSelect: () => void;
};

function isApplePlatform() {
  if (typeof navigator === "undefined") return false;
  // platform is deprecated but still the most reliable Apple check in browsers.
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

function botSearchText(bot: Bot) {
  return `${bot.name} ${bot.description} ${bot.preview}`.toLowerCase();
}

function botSubtitle(bot: Bot) {
  return bot.description.trim() || bot.preview.trim();
}

export function CommandPalette({
  open,
  onOpenChange,
  bots,
  onSelectBot,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bots: Bot[];
  onSelectBot: (botId: string) => void;
  actions: CommandPaletteAction[];
}) {
  const [search, setSearch] = useState("");
  const [modKey, setModKey] = useState("⌘");

  useEffect(() => {
    setModKey(isApplePlatform() ? "⌘" : "Ctrl");
  }, []);

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const filteredBots = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return bots;
    return bots.filter((bot) => botSearchText(bot).includes(needle));
  }, [bots, search]);

  const filteredActions = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return actions;
    return actions.filter((action) => action.label.toLowerCase().includes(needle));
  }, [actions, search]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.repeat) {
        return;
      }
      if (!/^[1-9]$/.test(event.key)) return;
      const bot = filteredBots[Number(event.key) - 1];
      if (!bot) return;
      event.preventDefault();
      onSelectBot(bot.id);
      onOpenChange(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filteredBots, onOpenChange, onSelectBot, open]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t`Command menu`}
      description={t`Search bots, actions, and settings`}
      className="sm:max-w-xl"
    >
      <Command
        shouldFilter={false}
        className="rounded-xl! bg-popover"
        data-testid="command-palette"
      >
        <CommandInput
          value={search}
          onValueChange={setSearch}
          placeholder={t`Search`}
          data-testid="command-palette-search"
        />
        <CommandList className="max-h-80" data-testid="command-palette-list">
          <CommandEmpty>
            <Trans>No results</Trans>
          </CommandEmpty>
          <CommandGroup>
            {filteredBots.map((bot, index) => {
              const subtitle = botSubtitle(bot);
              const shortcut = index < 9 ? `${modKey}${index + 1}` : null;
              return (
                <CommandItem
                  key={bot.id}
                  value={bot.id}
                  data-testid={`command-palette-bot-${bot.id}`}
                  onSelect={() => {
                    onSelectBot(bot.id);
                    onOpenChange(false);
                  }}
                  className="items-center gap-3 rounded-xl! px-2.5 py-2.5"
                >
                  <BotAvatar
                    avatarSet={bot.avatarSet}
                    color={bot.color}
                    identity={bot.id}
                    size={32}
                    status={bot.status}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground" dir="auto">
                      {bot.name}
                    </div>
                    {subtitle ? (
                      <div className="mt-0.5 truncate text-[13px] text-muted-foreground" dir="auto">
                        {subtitle}
                      </div>
                    ) : null}
                  </div>
                  {shortcut ? (
                    <CommandShortcut className="tracking-normal">
                      <Kbd>{shortcut}</Kbd>
                    </CommandShortcut>
                  ) : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
          {filteredActions.length > 0 ? (
            <CommandGroup>
              {filteredActions.map((action) => (
                <CommandItem
                  key={action.id}
                  value={action.id}
                  aria-checked={action.checked}
                  data-testid={`command-palette-action-${action.id}`}
                  onSelect={() => {
                    onOpenChange(false);
                    action.onSelect();
                  }}
                  className="items-center gap-3 rounded-xl! px-2.5 py-2.5"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <action.icon size={16} strokeWidth={1.8} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                    {action.label}
                  </span>
                  {action.checked ? (
                    <Check
                      size={16}
                      strokeWidth={1.8}
                      className="text-muted-foreground"
                      aria-hidden
                    />
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

export { isCommandPaletteHotkey } from "./command-palette-hotkey";
