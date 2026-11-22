import { Trans } from "@lingui/react/macro";
import type { Bot, BotAvatarSet, BotSection, Group } from "@rakazo/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ComponentProps, RefObject } from "react";
import { useDeferredValue, useState } from "react";
import { PAGE_PARAM } from "../../lib/pages/pages";
import { useSpaceQueries } from "../../lib/query/query";
import type { createSpaceRpc, RpcClient } from "../../lib/query/rpc";
import { selectSpace } from "../../lib/query/rpc";
import type { CreateBotDialogInput } from "./bots/create-bot-dialog";
import { CreateBotDialog } from "./bots/create-bot-dialog";
import type { CommandPaletteAction } from "./command-palette";
import { CommandPalette } from "./command-palette";
import {
  ClearConversationDialog,
  DeleteBotDialog,
  DeleteItemDialog,
  NewBotSectionDialog,
  NewSpaceDialog,
  RenameBotSectionDialog,
} from "./create-delete-dialogs";
import type { Panel } from "./right-panel-state";

type ChatTarget = { kind: "bot"; chat: Bot } | { kind: "group"; chat: Group };
type SectionTarget = { section: BotSection; spaceId: string };

/** Which of the shell's dialogs and menus are open, and on what. */
export function useShellDialogs() {
  const [deleteTarget, setDeleteTarget] = useState<Bot | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<Group | null>(null);
  const [clearTarget, setClearTarget] = useState<ChatTarget | null>(null);
  const [newSectionTarget, setNewSectionTarget] = useState<ChatTarget | null>(null);
  const [renameSectionTarget, setRenameSectionTarget] = useState<SectionTarget | null>(null);
  const [deleteSectionTarget, setDeleteSectionTarget] = useState<SectionTarget | null>(null);
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [createBotOpen, setCreateBotOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  return {
    deleteTarget,
    setDeleteTarget,
    deleteGroupTarget,
    setDeleteGroupTarget,
    clearTarget,
    setClearTarget,
    newSectionTarget,
    setNewSectionTarget,
    renameSectionTarget,
    setRenameSectionTarget,
    deleteSectionTarget,
    setDeleteSectionTarget,
    newSpaceOpen,
    setNewSpaceOpen,
    createBotOpen,
    setCreateBotOpen,
    commandPaletteOpen,
    setCommandPaletteOpen,
  };
}

export type ShellDialogsState = ReturnType<typeof useShellDialogs>;

/** The shell's confirmation dialogs and command palette. */
export function ShellDialogs({
  dialogs,
  rpc,
  bots,
  activeId,
  activeGroupId,
  alive,
  navigate,
  setPanel,
  refreshBots,
  closeMobileSidebar,
  createBot,
  botAvatarSet,
  clearOpenThread,
  discardChatAttachments,
  deleteRoutineDialogProps,
  paletteActions,
}: {
  dialogs: ShellDialogsState;
  rpc: ReturnType<typeof createSpaceRpc>;
  bots: Bot[];
  activeId: string | undefined;
  activeGroupId: string | undefined;
  alive: RefObject<boolean>;
  navigate: (path: string) => void;
  setPanel: (panel: Panel) => void;
  refreshBots: (includeArchived?: boolean) => Promise<void>;
  closeMobileSidebar: () => void;
  createBot: (input: CreateBotDialogInput, client: RpcClient) => Promise<void>;
  /** The account's set, which a new bot takes. */
  botAvatarSet: BotAvatarSet;
  clearOpenThread: () => void;
  /** Drops a deleted chat's pending attachments with their previews. */
  discardChatAttachments: (threadKey: string) => void;
  deleteRoutineDialogProps: ComponentProps<typeof DeleteItemDialog> | null;
  paletteActions: CommandPaletteAction[];
}) {
  const {
    deleteTarget,
    setDeleteTarget,
    deleteGroupTarget,
    setDeleteGroupTarget,
    clearTarget,
    setClearTarget,
    newSectionTarget,
    setNewSectionTarget,
    renameSectionTarget,
    setRenameSectionTarget,
    deleteSectionTarget,
    setDeleteSectionTarget,
    newSpaceOpen,
    setNewSpaceOpen,
    createBotOpen,
    setCreateBotOpen,
    commandPaletteOpen,
    setCommandPaletteOpen,
  } = dialogs;
  const queries = useSpaceQueries();
  const [pageSearch, setPageSearch] = useState("");
  const pageQuery = useDeferredValue(pageSearch.trim());
  const pages = useQuery({
    ...queries.pages.list.queryOptions({ input: pageQuery ? { query: pageQuery } : {} }),
    enabled: commandPaletteOpen,
    placeholderData: keepPreviousData,
  });
  return (
    <>
      {deleteTarget ? (
        <DeleteBotDialog
          bot={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async (deleteMemories) => {
            await rpc.bots.remove({ botId: deleteTarget.id, deleteMemories });
            discardChatAttachments(deleteTarget.id);
            setDeleteTarget(null);
            setPanel(null);
            await refreshBots(true);
          }}
        />
      ) : null}

      {deleteGroupTarget ? (
        <DeleteItemDialog
          item={deleteGroupTarget}
          noun="group"
          onCancel={() => setDeleteGroupTarget(null)}
          onConfirm={async () => {
            await rpc.groups.remove({ groupId: deleteGroupTarget.id });
            discardChatAttachments(deleteGroupTarget.id);
            setDeleteGroupTarget(null);
            setPanel(null);
            await refreshBots(true);
          }}
        />
      ) : null}

      {newSectionTarget ? (
        <NewBotSectionDialog
          bot={newSectionTarget.chat}
          onCancel={() => setNewSectionTarget(null)}
          onConfirm={async (name, client) => {
            await client.botSections.create(
              newSectionTarget.kind === "bot"
                ? { botId: newSectionTarget.chat.id, name }
                : { groupId: newSectionTarget.chat.id, name },
            );
            setNewSectionTarget(null);
            await refreshBots();
          }}
        />
      ) : null}

      {renameSectionTarget ? (
        <RenameBotSectionDialog
          section={renameSectionTarget.section}
          onCancel={() => setRenameSectionTarget(null)}
          onConfirm={async (name, client) => {
            await client.botSections.update(
              {
                sectionId: renameSectionTarget.section.id,
                name,
              },
              { context: { spaceId: renameSectionTarget.spaceId } },
            );
            setRenameSectionTarget(null);
            await refreshBots();
          }}
        />
      ) : null}

      {deleteSectionTarget ? (
        <DeleteItemDialog
          item={deleteSectionTarget.section}
          noun="section"
          description={<Trans>Its bots and groups are kept and leave the section.</Trans>}
          onCancel={() => setDeleteSectionTarget(null)}
          onConfirm={async () => {
            await rpc.botSections.remove(
              { sectionId: deleteSectionTarget.section.id },
              { context: { spaceId: deleteSectionTarget.spaceId } },
            );
            setDeleteSectionTarget(null);
            await refreshBots();
          }}
        />
      ) : null}

      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        bots={bots}
        onSelectBot={(id) => {
          closeMobileSidebar();
          navigate(`/app/${id}`);
        }}
        pages={pages.data?.items.filter((page) => page.groupId || page.botId)}
        onSearchChange={setPageSearch}
        onSelectPage={(page) => {
          closeMobileSidebar();
          const chat = page.groupId ? `/app/g/${page.groupId}` : `/app/${page.botId}`;
          navigate(`${chat}?${PAGE_PARAM}=${encodeURIComponent(page.id)}`);
        }}
        actions={paletteActions.map((action) => ({
          ...action,
          onSelect: () => {
            closeMobileSidebar();
            action.onSelect();
          },
        }))}
      />

      {createBotOpen ? (
        <CreateBotDialog
          avatarSet={botAvatarSet}
          onCancel={() => setCreateBotOpen(false)}
          onCreate={createBot}
        />
      ) : null}

      {newSpaceOpen ? (
        <NewSpaceDialog
          onCancel={() => setNewSpaceOpen(false)}
          onCreate={async (name, client) => (await client.spaces.create({ name })).id}
          loadItems={() => rpc.availability.items()}
          chooseItems={async (spaceId, items, client) => {
            await client.availability.chooseForSpace({
              spaceId,
              items: items.map(({ kind, id }) => ({ kind, id })),
            });
          }}
          onDone={(spaceId) => {
            if (!alive.current) return;
            if (!selectSpace(spaceId)) {
              setNewSpaceOpen(false);
              void refreshBots();
              return;
            }
            window.location.assign("/onboarding");
          }}
        />
      ) : null}

      {clearTarget ? (
        <ClearConversationDialog
          bot={clearTarget.chat}
          onCancel={() => setClearTarget(null)}
          onConfirm={async () => {
            await rpc.threads.clear(
              clearTarget.kind === "bot"
                ? { botId: clearTarget.chat.id }
                : { groupId: clearTarget.chat.id },
            );
            if (
              (clearTarget.kind === "bot" && activeId === clearTarget.chat.id) ||
              (clearTarget.kind === "group" && activeGroupId === clearTarget.chat.id)
            ) {
              clearOpenThread();
            }
            setClearTarget(null);
            await refreshBots();
          }}
        />
      ) : null}

      {deleteRoutineDialogProps ? <DeleteItemDialog {...deleteRoutineDialogProps} /> : null}
    </>
  );
}
