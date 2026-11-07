import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Group } from "@rakazo/contracts";
import { BotAvatar, Button, GroupAvatar } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { DeleteBotDialog, DeleteItemDialog } from "./shell/dialogs";

/** The open space's archived chats, each restorable or deletable. */
export function ArchivedChatsSettings({
  rpc,
  onChange,
}: {
  rpc: RpcClient;
  /** After a restore or delete, so the chat list matches; a deleted chat's id comes along. */
  onChange: (deletedId?: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const [chats, setChats] = useState<{ bots: Bot[]; groups: Group[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [deleteBot, setDeleteBot] = useState<Bot | null>(null);
  const [deleteGroup, setDeleteGroup] = useState<Group | null>(null);
  const load = useCallback(async () => {
    try {
      const [bots, groups] = await Promise.all([
        rpc.bots.listArchived(),
        rpc.groups.listArchived(),
      ]);
      setChats({ bots, groups });
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [rpc]);
  useEffect(() => {
    void load();
  }, [load]);
  const changed = async (deletedId?: string) => {
    await load();
    await onChange(deletedId).catch(() => undefined);
  };

  if (failed && !chats) {
    return (
      <p className="text-body text-muted-foreground">
        <Trans>Could not load</Trans>
      </p>
    );
  }
  if (!chats) return null;
  if (chats.bots.length + chats.groups.length === 0) {
    return (
      <p className="text-body text-muted-foreground">
        <Trans>No archived chats</Trans>
      </p>
    );
  }
  const row = (
    key: string,
    name: string,
    avatar: ReactNode,
    restore: () => Promise<unknown>,
    remove: () => void,
  ) => (
    <li key={key} className="flex items-center gap-3 py-2">
      {avatar}
      <span className="min-w-0 flex-1 truncate text-body text-foreground" dir="auto">
        {name}
      </span>
      <Button variant="ghost" size="sm" onClick={() => void restore().then(() => changed())}>
        <Trans>Restore</Trans>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        aria-label={t`Delete ${name}`}
        onClick={remove}
      >
        <Trans>Delete</Trans>
      </Button>
    </li>
  );
  return (
    <>
      <ul className="flex flex-col divide-y divide-border">
        {chats.bots.map((bot) =>
          row(
            `bot:${bot.id}`,
            bot.name,
            <BotAvatar
              avatarSet={bot.avatarSet}
              color={bot.color}
              identity={bot.id}
              size={32}
              status={bot.status}
            />,
            () => rpc.bots.restore({ botId: bot.id }),
            () => setDeleteBot(bot),
          ),
        )}
        {chats.groups.map((group) =>
          row(
            `group:${group.id}`,
            group.name,
            <GroupAvatar members={group.members} size={32} />,
            () => rpc.groups.restore({ groupId: group.id }),
            () => setDeleteGroup(group),
          ),
        )}
      </ul>
      {deleteBot ? (
        <DeleteBotDialog
          bot={deleteBot}
          onCancel={() => setDeleteBot(null)}
          onConfirm={async (deleteMemories) => {
            await rpc.bots.remove({ botId: deleteBot.id, deleteMemories });
            setDeleteBot(null);
            await changed(deleteBot.id);
          }}
        />
      ) : null}
      {deleteGroup ? (
        <DeleteItemDialog
          item={deleteGroup}
          noun="group"
          onCancel={() => setDeleteGroup(null)}
          onConfirm={async () => {
            await rpc.groups.remove({ groupId: deleteGroup.id });
            setDeleteGroup(null);
            await changed(deleteGroup.id);
          }}
        />
      ) : null}
    </>
  );
}
