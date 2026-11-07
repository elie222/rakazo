import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Group } from "@rakazo/contracts";
import { BotAvatar, Button, GroupAvatar } from "@rakazo/ui-web";
import type { createSpaceRpc } from "../../lib/rpc";
import { SidebarShelf } from "./sidebar-shelf";

export function ArchivedChats({
  archivedBots,
  archivedGroups,
  showSpaceSearch,
  rpc,
  refreshBots,
  setDeleteTarget,
  setDeleteGroupTarget,
}: {
  archivedBots: Bot[];
  archivedGroups: Group[];
  showSpaceSearch: boolean;
  rpc: ReturnType<typeof createSpaceRpc>;
  refreshBots: (includeArchived?: boolean) => Promise<void>;
  setDeleteTarget: (bot: Bot) => void;
  setDeleteGroupTarget: (group: Group) => void;
}) {
  const { t } = useLingui();
  return archivedBots.length + archivedGroups.length > 0 && !showSpaceSearch ? (
    <SidebarShelf
      title={<Trans>Archived</Trans>}
      count={archivedBots.length + archivedGroups.length}
    >
      {archivedBots.map((bot) => (
        <div key={bot.id} className="flex items-center gap-2 rounded-lg px-2.5 py-2">
          <BotAvatar
            avatarSet={bot.avatarSet}
            color={bot.color}
            identity={bot.id}
            size={28}
            status={bot.status}
          />
          <span className="min-w-0 flex-1 truncate text-body text-foreground/75" dir="auto">
            {bot.name}
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void rpc.bots.restore({ botId: bot.id }).then(() => refreshBots(true))}
          >
            <Trans>Restore</Trans>
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="text-destructive hover:text-destructive"
            aria-label={t`Delete ${bot.name}`}
            onClick={() => setDeleteTarget(bot)}
          >
            <Trans>Delete</Trans>
          </Button>
        </div>
      ))}
      {archivedGroups.map((group) => (
        <div key={group.id} className="flex items-center gap-2 rounded-lg px-2.5 py-2">
          <GroupAvatar members={group.members} size={28} />
          <span className="min-w-0 flex-1 truncate text-body text-foreground/75" dir="auto">
            {group.name}
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              void rpc.groups.restore({ groupId: group.id }).then(() => refreshBots(true))
            }
          >
            <Trans>Restore</Trans>
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="text-destructive hover:text-destructive"
            aria-label={t`Delete ${group.name}`}
            onClick={() => setDeleteGroupTarget(group)}
          >
            <Trans>Delete</Trans>
          </Button>
        </div>
      ))}
    </SidebarShelf>
  ) : null;
}
