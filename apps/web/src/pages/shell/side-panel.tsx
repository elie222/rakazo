import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Group, ThreadSnapshot, TopicSummary } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { X } from "lucide-react";
import type { ComponentProps, Dispatch, ReactNode, SetStateAction } from "react";
import { PagesList } from "../../components/pages/PagesList";
import type { SpaceQueries } from "../../lib/query/query";
import type { createSpaceRpc } from "../../lib/query/rpc";
import { RoutineEditor } from "../routines/RoutineEditor";
import type { RoutineList } from "../routines/RoutineList";
import { CreateGroupForm, GroupSettings } from "../space/GroupPanel";
import { BotSettings } from "./bots/bot-panel";
import { ResizableSidePanel } from "./resizable-side-panel";
import type { Panel } from "./right-panel-state";
import type { ThreadMessageContext } from "./topics/thread-panel";
import { ThreadPanel } from "./topics/thread-panel";
import { ThreadsListPanel } from "./topics/threads-list-panel";
import { firstThreadRoute } from "./use-shell-navigation";

/** The panel beside the chat: a bot, a routine, a group, an import, or the bot chat's threads. */
export function ShellSidePanel({
  rpc,
  threads,
  panel,
  setPanel,
  active,
  activeGroup,
  bots,
  groups,
  setBots,
  setGroups,
  navigate,
  refreshBots,
  refreshGroupThread,
  computerOpen,
  computerPanel,
  routineList,
  routineEditorProps,
  openBot,
  modelFocusRequest,
  onClearBot,
  discardChatAttachments,
  onCoversChat,
  onOverlays,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  /** The open bot chat's threads; undefined in a group. */
  threads:
    | {
        queries: SpaceQueries;
        topics: readonly TopicSummary[];
        /** The thread the "thread" panel shows, when it belongs to this chat. */
        topicId: string | undefined;
        onOpen: (topicId: string) => void;
        meId: string | undefined;
        messageContext: ThreadMessageContext;
      }
    | undefined;
  panel: Panel;
  setPanel: (panel: Panel) => void;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  bots: Bot[];
  groups: Group[];
  setBots: Dispatch<SetStateAction<Bot[]>>;
  setGroups: Dispatch<SetStateAction<Group[]>>;
  navigate: (path: string, options?: { replace?: boolean }) => void;
  refreshBots: (includeArchived?: boolean) => Promise<void>;
  refreshGroupThread: (groupId: string) => Promise<ThreadSnapshot>;
  computerOpen: boolean;
  computerPanel: ReactNode;
  routineList: Omit<ComponentProps<typeof RoutineList>, "preview">;
  routineEditorProps: ComponentProps<typeof RoutineEditor> | null;
  openBot: (botId: string) => void;
  modelFocusRequest: number;
  onClearBot: (bot: Bot) => void;
  /** Drops a deleted chat's pending attachments with their previews. */
  discardChatAttachments: (threadKey: string) => void;
  onCoversChat: (covers: boolean) => void;
  onOverlays: (overlays: boolean) => void;
}) {
  const { t } = useLingui();
  // A thread opened from another chat, or the list in a group, has nothing to show here.
  const threadsView =
    active && threads && (panel === "threads" || (panel === "thread" && threads.topicId))
      ? { active, threads, topicId: panel === "thread" ? threads.topicId : undefined }
      : null;
  const open =
    panel === "threads" || panel === "thread"
      ? Boolean(threadsView)
      : Boolean(panel && (active || activeGroup));
  const botView = panel === "routines" || panel === "pages" || panel === "settings" ? panel : null;

  async function createGroup(input: { name: string; botIds: string[] }) {
    const group = await rpc.groups.create(input);
    setGroups((current) =>
      current.some((item) => item.id === group.id) ? current : [group, ...current],
    );
    navigate(`/app/g/${group.id}`);
    setPanel(null);
    await refreshBots().catch(() => undefined);
  }

  return (
    <ResizableSidePanel
      open={open}
      panel={panel ?? "closed"}
      onCoversChat={onCoversChat}
      onOverlays={onOverlays}
      onEscape={panel === "settings" && !computerOpen ? () => setPanel(null) : undefined}
    >
      {threadsView?.topicId ? (
        <ThreadPanel
          key={threadsView.topicId}
          rpc={rpc}
          queries={threadsView.threads.queries}
          bot={threadsView.active}
          topicId={threadsView.topicId}
          topic={threadsView.threads.topics.find((topic) => topic.id === threadsView.topicId)}
          meId={threadsView.threads.meId}
          messageContext={threadsView.threads.messageContext}
          onClose={() => setPanel(null)}
        />
      ) : threadsView ? (
        <ThreadsListPanel
          topics={threadsView.threads.topics}
          onOpen={threadsView.threads.onOpen}
          onClose={() => setPanel(null)}
        />
      ) : open ? (
        <div className="rk-scroll h-full w-full overflow-y-auto px-5 pt-3.5 pb-[17px]">
          {!(botView && active) &&
          panel !== "routine" &&
          panel !== "create-group" &&
          panel !== "group-settings" ? (
            <div className="mb-4 flex items-center justify-between">
              {!active && panel !== "settings" ? (
                <span className="text-body text-muted-foreground">
                  <Trans>Group</Trans>
                </span>
              ) : null}
              <div className="ml-auto flex gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t`Close panel`}
                  onClick={() => setPanel(null)}
                >
                  <X className="size-4.5" strokeWidth={1.75} />
                </Button>
              </div>
            </div>
          ) : null}
          {panel === "create-group" ? (
            <CreateGroupForm
              bots={bots}
              onCancel={() => setPanel(null)}
              onCreate={(input) => createGroup(input)}
              onOpenBot={(botId) => {
                setPanel(null);
                openBot(botId);
              }}
            />
          ) : null}
          {panel === "group-settings" && activeGroup ? (
            <GroupSettings
              key={activeGroup.id}
              group={activeGroup}
              bots={bots}
              pages={<PagesList groupId={activeGroup.id} />}
              onSave={async (input) => {
                const updated = await rpc.groups.update({ groupId: activeGroup.id, ...input });
                setGroups((current) =>
                  current.map((group) => (group.id === updated.id ? updated : group)),
                );
                void Promise.all([refreshBots(), refreshGroupThread(activeGroup.id)]).catch(
                  () => undefined,
                );
              }}
              onRemove={async () => {
                await rpc.groups.remove({ groupId: activeGroup.id });
                discardChatAttachments(activeGroup.id);
                const remainingGroups = groups.filter((group) => group.id !== activeGroup.id);
                setGroups(remainingGroups);
                setPanel(null);
                navigate(firstThreadRoute(bots, remainingGroups), { replace: true });
                await refreshBots().catch(() => undefined);
              }}
              onClose={() => setPanel(null)}
              onOpenBot={openBot}
              covered={computerOpen}
            />
          ) : null}
          {botView && active ? (
            <BotSettings
              key={active.id}
              bot={active}
              view={botView}
              onViewChange={setPanel}
              onClose={() => setPanel(null)}
              computer={computerPanel}
              routines={routineList}
              focusModel={modelFocusRequest}
              onSave={async ({ computerMode, ...patch }) => {
                if (computerMode !== undefined && computerMode !== active.computerMode) {
                  await rpc.bots.setComputer({
                    botId: active.id,
                    mode: computerMode,
                  });
                }
                const updated = await rpc.bots.update({ botId: active.id, ...patch });
                setBots((current) => current.map((bot) => (bot.id === updated.id ? updated : bot)));
                // Persistence succeeded; a failed navigation refresh must not undo the tool edit.
                await refreshBots().catch(() => undefined);
              }}
              onExport={async () => {
                const manifest = await rpc.export.bot({ botId: active.id });
                const blob = new Blob([JSON.stringify(manifest, null, 2)], {
                  type: "application/json",
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${active.name.toLowerCase().replace(/\s+/g, "-")}-export.json`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              onClear={() => onClearBot(active)}
            />
          ) : null}
          {panel === "routine" && routineEditorProps ? (
            <RoutineEditor {...routineEditorProps} />
          ) : null}
        </div>
      ) : null}
    </ResizableSidePanel>
  );
}
