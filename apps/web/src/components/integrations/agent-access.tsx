import { Plural, Trans } from "@lingui/react/macro";
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { ChevronDown } from "lucide-react";

export type AgentAccess = { allBots: boolean; botIds: string[] };

/**
 * Which agents can use something: all of them, or the ones picked. With one agent it only
 * shows when that agent is left out, since "all" already covers it.
 */
export function AgentAccessControl({
  bots,
  access,
  disabled,
  onChange,
}: {
  bots: Array<{ id: string; name: string }>;
  access: AgentAccess;
  disabled?: boolean;
  onChange: (next: AgentAccess) => void;
}) {
  const chosen = access.allBots ? bots.map((bot) => bot.id) : access.botIds;
  if (bots.length === 0 || (bots.length === 1 && chosen.length === 1)) return null;
  const summary = access.allBots ? (
    <Trans>All agents</Trans>
  ) : chosen.length === 0 ? (
    <Trans>No agents</Trans>
  ) : chosen.length === 1 ? (
    bots.find((bot) => bot.id === chosen[0])?.name
  ) : (
    <Plural value={chosen.length} one="# agent" other="# agents" />
  );
  const toggle = (botId: string) =>
    onChange({
      allBots: false,
      botIds: chosen.includes(botId) ? chosen.filter((id) => id !== botId) : [...chosen, botId],
    });

  return (
    <div data-testid="agent-access" className="flex flex-wrap items-center gap-1 text-xs">
      <span className="text-muted-foreground">
        <Trans>Agents</Trans>
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              className="h-6 gap-1 px-1.5 text-xs font-normal text-foreground"
            />
          }
        >
          {summary}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuCheckboxItem
            checked={access.allBots}
            onCheckedChange={(allBots) => onChange({ ...access, allBots })}
          >
            <Trans>All agents</Trans>
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          {bots.map((bot) => (
            <DropdownMenuCheckboxItem
              key={bot.id}
              checked={chosen.includes(bot.id)}
              onCheckedChange={() => toggle(bot.id)}
            >
              {bot.name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
