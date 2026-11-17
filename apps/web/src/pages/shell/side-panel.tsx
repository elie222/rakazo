import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Group, ThreadSnapshot } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { X } from "lucide-react";
import type { ComponentProps, Dispatch, ReactNode, SetStateAction } from "react";
import { PagesList } from "../../components/pages/PagesList";
import type { Panel } from "../../lib/right-panel-state";
import type { createSpaceRpc } from "../../lib/rpc";
import { CreateGroupForm, GroupSettings } from "../GroupPanel";
import { ResizableSidePanel } from "../ResizableSidePanel";
import { RoutineEditor } from "../RoutineEditor";
import type { RoutineList } from "../RoutineList";
import { AgentImportForm } from "./agent-import";
import { BotSettings } from "./bot-panel";
import { firstThreadRoute } from "./use-shell-navigation";

/** The panel beside the chat: a bot, a routine, a group, or an import. */
export function ShellSidePanel({
  rpc,
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
  openCreatedBot,
  modelFocusRequest,
  onClearBot,
  discardChatAttachments,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
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
  openCreatedBot: (bot: Bot) => void;
  modelFocusRequest: number;
  onClearBot: (bot: Bot) => void;
  /** Drops a deleted chat's pending attachments with their previews. */
  discardChatAttachments: (threadKey: string) => void;
}) {
  const { t } = useLingui();
  const open = Boolean(panel && (active || activeGroup || panel === "import-agent"));
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
    <ResizableSidePanel open={open} panel={panel ?? "closed"}>
      {open ? (
        <div className="rk-scroll h-full w-full overflow-y-auto px-5 py-[17px]">
          {!(botView && active) &&
          panel !== "routine" &&
          panel !== "create-group" &&
          panel !== "group-settings" &&
          panel !== "import-agent" ? (
            <div className="mb-4 flex items-center justify-between">
              {!active && panel !== "settings" ? (
                <span className="text-body text-muted-foreground">
                  <Trans>Group</Trans>
                </span>
              ) : null}
              <div className="ml-auto flex gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t`Close panel`}
                  onClick={() => setPanel(null)}
                >
                  <X size={16} strokeWidth={1.8} />
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
          {panel === "import-agent" ? (
            <AgentImportForm
              onClose={() => setPanel(null)}
              onCreated={(bot) => {
                openCreatedBot(bot);
                void refreshBots().catch(() => undefined);
              }}
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
