import { i18n } from "@lingui/core";
import { plural, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, BotSection, Group, Me, Space, ThreadSnapshot } from "@rakazo/contracts";
import {
  BotAvatar,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  GroupAvatar,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@rakazo/ui-web";
import {
  ChevronDown,
  CircleAlert,
  Globe,
  Lock,
  Pencil,
  Settings,
  Trash2,
  Users,
} from "lucide-react";
import { IconTooltip } from "../../../components/IconTooltip";
import {
  compactRosterStatusLabel,
  rosterHasUndismissedRunError,
  rosterWorkStatusLabel,
} from "../../../lib/chat/roster-status";
import type { BotsSidebarDensity } from "../../../lib/preferences/bots-sidebar-density-pref";
import type { ChatMenuState } from "../chat/chat-context-menu";
import { ChatMenu } from "../chat/chat-context-menu";
import { useRedrawAtMidnight } from "../chat/use-redraw-at-midnight";
import type { RosterDropAction, RosterDropTarget } from "./roster-drop";
import type { sidebarGroupsForSpaces } from "./space-sidebar";

export function SidebarRoster({
  sidebarGroups,
  collapsedSidebarSections,
  bootstrapMe,
  botSections,
  spaces,
  rosterDropKey,
  setRosterDropKey,
  rosterDropAction,
  applyRosterDrop,
  openSpaceChat,
  openSpaceSettings,
  setRenameSectionTarget,
  setDeleteSectionTarget,
  toggleSidebarSection,
  inGroup,
  active,
  activeGroup,
  botsSidebarDensity,
  dismissedRunErrorIds,
  displayedRunError,
  draggedBotId,
  setDraggedBotId,
  chatMenu,
  reorderRosterBot,
  activeSnapshot,
  mini = false,
}: {
  sidebarGroups: ReturnType<
    typeof sidebarGroupsForSpaces<Space["bots"][number], Space["groups"][number]>
  >;
  collapsedSidebarSections: ReadonlySet<string>;
  bootstrapMe: Pick<Me, "spaceId"> | null | undefined;
  botSections: BotSection[];
  spaces: Space[];
  rosterDropKey: string | null;
  setRosterDropKey: (key: string | null) => void;
  rosterDropAction: (target: RosterDropTarget, sameList: boolean) => RosterDropAction | null;
  applyRosterDrop: (target: RosterDropTarget, sameList: boolean, botIds: string[]) => void;
  openSpaceChat: (spaceId: string, path: string) => void;
  openSpaceSettings: (spaceId: string) => void;
  setRenameSectionTarget: (target: { section: BotSection; spaceId: string }) => void;
  setDeleteSectionTarget: (target: { section: BotSection; spaceId: string }) => void;
  toggleSidebarSection: (key: string) => void;
  inGroup: boolean;
  active: Pick<Bot, "id"> | undefined;
  activeGroup: Pick<Group, "id"> | undefined;
  botsSidebarDensity: BotsSidebarDensity;
  dismissedRunErrorIds: ReadonlySet<string>;
  displayedRunError: string | null;
  draggedBotId: string | null;
  setDraggedBotId: (id: string | null) => void;
  chatMenu: ChatMenuState;
  reorderRosterBot: (sourceId: string, targetId: string, groupBotIds: string[]) => void;
  activeSnapshot: ThreadSnapshot | null;
  mini?: boolean;
}) {
  useRedrawAtMidnight();
  const { t } = useLingui();
  return (
    <>
      {sidebarGroups.map((group, groupIndex) => {
        const collapsed = Boolean(group.title) && collapsedSidebarSections.has(group.key);
        const groupBotIds = group.bots.flatMap((item) =>
          item.kind === "bot" ? [item.chat.id] : [],
        );
        const settingsLabel = group.canOpenSpaceSettings
          ? t`Settings for ${group.spaceName}`
          : null;
        const chatCount = collapsed ? group.bots.length : 0;
        const tiles = group.tiles && !mini;
        const headerDropTarget: RosterDropTarget | null =
          group.spaceId === bootstrapMe?.spaceId &&
          !group.emptySpaceId &&
          (group.sectionId || group.key.endsWith("unassigned"))
            ? { kind: "section", sectionId: group.sectionId }
            : null;
        const headerDropKey = `header:${group.key}`;
        const section = group.sectionId
          ? (group.spaceId === bootstrapMe?.spaceId
              ? botSections
              : (spaces.find((space) => space.id === group.spaceId)?.botSections ?? [])
            ).find((item) => item.id === group.sectionId)
          : undefined;
        return (
          <Collapsible
            key={group.key}
            open={mini || !collapsed}
            onOpenChange={() => {
              if (!mini) toggleSidebarSection(group.key);
            }}
            data-sidebar-group={group.key}
            className={`flex flex-col gap-0.5 ${mini && groupIndex > 0 ? "mt-2 border-t border-sidebar-border pt-2" : ""}`}
          >
            {!mini && group.title ? (
              // biome-ignore lint/a11y/useSemanticElements: groups sidebar controls, not form fields; Move to remains the keyboard alternative.
              <div
                role="group"
                data-roster-drop={rosterDropKey === headerDropKey ? "true" : undefined}
                className={`group/header mt-2 grid rounded-lg ${rosterDropKey === headerDropKey ? "bg-sidebar-accent" : ""}`}
                onDragOver={(event) => {
                  if (!headerDropTarget || !rosterDropAction(headerDropTarget, false)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  if (rosterDropKey !== headerDropKey) setRosterDropKey(headerDropKey);
                }}
                onDragLeave={() => {
                  if (rosterDropKey === headerDropKey) setRosterDropKey(null);
                }}
                onDrop={(event) => {
                  if (!headerDropTarget) return;
                  event.preventDefault();
                  applyRosterDrop(headerDropTarget, false, groupBotIds);
                }}
              >
                <ContextMenu disabled={!section}>
                  <ContextMenuTrigger
                    render={group.emptySpaceId ? <button type="button" /> : <CollapsibleTrigger />}
                    className="col-start-1 row-start-1 flex w-full min-w-0 items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-start text-body-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                    onClick={() => {
                      if (group.emptySpaceId) {
                        openSpaceChat(group.emptySpaceId, "/onboarding");
                      }
                    }}
                    onContextMenu={section ? (event) => event.currentTarget.focus() : undefined}
                    aria-description={
                      chatCount > 0
                        ? t`${plural(chatCount, { one: "# chat", other: "# chats" })}`
                        : undefined
                    }
                    aria-label={
                      (group.emptySpaceId
                        ? t`Open ${headerName(group)}`
                        : collapsed
                          ? t`Expand ${headerName(group)}`
                          : t`Collapse ${headerName(group)}`) +
                      // The button's own name is what is read, so the globe's meaning joins it.
                      (group.hasGuests ? `, ${t`Shared with guests`}` : "")
                    }
                  >
                    <span
                      className={`flex min-w-0 items-center gap-1.5 truncate ${settingsLabel ? "pe-7" : ""}`}
                    >
                      {/* People from outside the organization are marked even in a lone Space. */}
                      {group.hasGuests ? (
                        <Globe size={11} strokeWidth={2} aria-hidden="true" />
                      ) : group.showLock ? (
                        group.shared ? (
                          <Users size={11} strokeWidth={2} aria-hidden="true" />
                        ) : (
                          <Lock size={11} strokeWidth={2} aria-hidden="true" />
                        )
                      ) : null}
                      <span className="truncate">{group.title}</span>
                      {group.subtitle ? (
                        <span className="ms-0.5 truncate text-muted-foreground">
                          {group.subtitle}
                        </span>
                      ) : null}
                    </span>
                    {group.emptySpaceId ? null : (
                      <span aria-hidden="true" className="grid shrink-0 place-items-center">
                        {chatCount > 0 ? (
                          <span className="col-start-1 row-start-1 hidden tabular-nums group-hover/header:invisible group-has-focus-visible/header:invisible [@media(hover:hover)_and_(pointer:fine)]:block">
                            {chatCount}
                          </span>
                        ) : null}
                        <ChevronDown
                          size={14}
                          strokeWidth={1.8}
                          className={`col-start-1 row-start-1 group-hover/header:visible group-has-focus-visible/header:visible motion-safe:transition-transform [@media(hover:hover)_and_(pointer:fine)]:invisible ${collapsed ? "-rotate-90 rtl:rotate-90" : ""}`}
                        />
                      </span>
                    )}
                  </ContextMenuTrigger>
                  {section ? (
                    <ContextMenuContent
                      aria-label={t`Actions for ${section.name}`}
                      className="w-[220px]"
                    >
                      <ContextMenuItem
                        onClick={() => setRenameSectionTarget({ section, spaceId: group.spaceId })}
                      >
                        <Pencil />
                        {t`Rename section`}
                      </ContextMenuItem>
                      <ContextMenuItem
                        variant="destructive"
                        onClick={() => setDeleteSectionTarget({ section, spaceId: group.spaceId })}
                      >
                        <Trash2 />
                        {t`Delete section`}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  ) : null}
                </ContextMenu>
                {settingsLabel ? (
                  <IconTooltip label={settingsLabel}>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className={`col-start-1 row-start-1 self-center justify-self-end text-muted-foreground group-hover/header:pointer-events-auto group-hover/header:opacity-100 group-has-focus-visible/header:pointer-events-auto group-has-focus-visible/header:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:opacity-0 ${group.emptySpaceId ? "me-1" : "me-7"}`}
                      aria-label={settingsLabel}
                      onClick={() => openSpaceSettings(group.spaceId)}
                    >
                      <Settings className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
                    </Button>
                  </IconTooltip>
                ) : null}
              </div>
            ) : null}
            <CollapsibleContent
              className={
                tiles ? "grid grid-cols-3 gap-x-1 gap-y-2 pt-1 pb-2" : "flex flex-col gap-0.5"
              }
            >
              {group.bots.map((item) => {
                const selected =
                  (item.kind === "bot" && !inGroup && active?.id === item.chat.id) ||
                  (item.kind === "group" && inGroup && activeGroup?.id === item.chat.id);
                const compact = botsSidebarDensity === "compact";
                const workStatusLabel =
                  item.kind === "bot" ? rosterWorkStatusLabel(item.chat.status) : null;
                const rowError =
                  item.kind === "bot" &&
                  (rosterHasUndismissedRunError(item.chat.runErrorId, dismissedRunErrorIds) ||
                    (active?.id === item.chat.id && Boolean(displayedRunError)));
                const compactStatusLabel =
                  (compact || mini || tiles) && item.kind === "bot"
                    ? rowError
                      ? t`Error`
                      : compactRosterStatusLabel(item.chat.status)
                    : null;
                const previewLine =
                  workStatusLabel ??
                  (item.kind === "bot"
                    ? item.chat.preview || (item.chat.status !== "idle" ? item.chat.status : "")
                    : item.chat.preview ||
                      item.chat.members.map((member) => member.name).join(", "));
                const rosterLine = compact ? compactStatusLabel : previewLine;
                const rowDropTarget: RosterDropTarget | null =
                  item.chat.spaceId !== bootstrapMe?.spaceId
                    ? null
                    : item.kind === "bot"
                      ? { kind: "bot", chat: item.chat }
                      : {
                          kind: "group",
                          chat: {
                            id: item.chat.id,
                            memberIds: item.chat.members.map((member) => member.botId),
                          },
                        };
                const rowSameList =
                  Boolean(draggedBotId) && groupBotIds.includes(draggedBotId ?? "");
                const rowDropKey = `row:${item.kind}:${item.chat.id}`;
                const groupMembers =
                  item.kind === "group" && item.chat.id === activeSnapshot?.groupId
                    ? (activeSnapshot.members ?? item.chat.members)
                    : item.kind === "group"
                      ? item.chat.members
                      : [];
                const avatarSize = tiles ? 56 : mini ? 40 : compact ? 28 : 38;
                const avatar =
                  item.kind === "bot" ? (
                    <BotAvatar
                      avatarSet={item.chat.avatarSet}
                      color={item.chat.color}
                      identity={item.chat.id}
                      size={avatarSize}
                      status={item.chat.status}
                    />
                  ) : (
                    <GroupAvatar members={groupMembers} size={avatarSize} />
                  );
                const chatTrigger = (
                  <ContextMenuTrigger
                    render={<button type="button" />}
                    draggable={item.kind === "bot"}
                    data-roster-bot-id={item.kind === "bot" ? item.chat.id : undefined}
                    data-roster-unread={item.chat.unread ? "true" : undefined}
                    data-roster-error={rowError && (compact || mini || tiles) ? "true" : undefined}
                    aria-current={selected ? "page" : undefined}
                    aria-label={mini ? item.chat.name : undefined}
                    aria-describedby={
                      mini || tiles
                        ? [
                            item.chat.unread ? `roster-unread-${item.kind}-${item.chat.id}` : null,
                            compactStatusLabel
                              ? `roster-status-${item.kind}-${item.chat.id}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" ") || undefined
                        : undefined
                    }
                    aria-keyshortcuts={
                      item.kind === "bot" ? "Alt+ArrowUp Alt+ArrowDown" : undefined
                    }
                    onDragStart={(event) => {
                      if (item.kind !== "bot") return;
                      setDraggedBotId(item.chat.id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", item.chat.id);
                    }}
                    onDragOver={(event) => {
                      if (!rowDropTarget || !rosterDropAction(rowDropTarget, rowSameList)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      if (rosterDropKey !== rowDropKey) setRosterDropKey(rowDropKey);
                    }}
                    onDragLeave={() => {
                      if (rosterDropKey === rowDropKey) setRosterDropKey(null);
                    }}
                    onDrop={(event) => {
                      if (!rowDropTarget) return;
                      event.preventDefault();
                      applyRosterDrop(rowDropTarget, rowSameList, groupBotIds);
                    }}
                    onDragEnd={() => {
                      setDraggedBotId(null);
                      setRosterDropKey(null);
                    }}
                    data-roster-drop={rosterDropKey === rowDropKey ? "true" : undefined}
                    onKeyDown={(event) => {
                      if (
                        item.kind !== "bot" ||
                        !event.altKey ||
                        (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                      )
                        return;
                      const siblings = groupBotIds;
                      const index = siblings.indexOf(item.chat.id);
                      const target = siblings[index + (event.key === "ArrowUp" ? -1 : 1)];
                      if (!target) return;
                      event.preventDefault();
                      reorderRosterBot(item.chat.id, target, groupBotIds);
                    }}
                    onClick={() => {
                      openSpaceChat(
                        item.chat.spaceId,
                        item.kind === "bot" ? `/app/${item.chat.id}` : `/app/g/${item.chat.id}`,
                      );
                    }}
                    // Focus the row so closing the menu returns focus here.
                    onContextMenu={(event) => event.currentTarget.focus()}
                    className={`flex items-center ${
                      tiles
                        ? "w-full min-w-0 flex-col gap-1.5 rounded-xl px-1 py-2"
                        : mini
                          ? "mx-auto size-12 justify-center rounded-xl"
                          : compact
                            ? "w-full min-h-11 gap-2 rounded-xl px-2.5 py-1.5"
                            : "w-full gap-3 rounded-xl px-2.5 py-[10px]"
                    } text-start ${
                      selected || rosterDropKey === rowDropKey
                        ? "bg-sidebar-accent"
                        : "group-hover/row:bg-accent"
                    }`}
                  >
                    {mini || tiles ? (
                      <span className="relative shrink-0">
                        {avatar}
                        {rowError ? (
                          <span
                            aria-hidden="true"
                            className="absolute -end-0.5 bottom-0 size-2 rounded-full bg-destructive ring-2 ring-sidebar"
                          />
                        ) : null}
                        {compactStatusLabel ? (
                          <span
                            className="sr-only"
                            id={`roster-status-${item.kind}-${item.chat.id}`}
                          >
                            {compactStatusLabel}
                          </span>
                        ) : null}
                        {item.chat.unread ? (
                          <>
                            <span
                              aria-hidden="true"
                              data-roster-unread-dot
                              className="absolute -end-0.5 top-0 size-2 rounded-full bg-unread ring-2 ring-sidebar"
                            />
                            <span
                              id={`roster-unread-${item.kind}-${item.chat.id}`}
                              className="sr-only"
                            >
                              <Trans> (unread)</Trans>
                            </span>
                          </>
                        ) : null}
                      </span>
                    ) : (
                      avatar
                    )}
                    {tiles ? (
                      <span
                        dir="auto"
                        className={`w-full truncate text-center text-body-sm text-foreground ${
                          item.chat.unread ? "font-semibold" : "font-medium"
                        }`}
                      >
                        {item.chat.name}
                      </span>
                    ) : null}
                    {tiles && item.woke ? (
                      <span data-roster-woke className="text-label font-medium text-foreground/75">
                        <Trans>Woke</Trans>
                      </span>
                    ) : !tiles && !mini ? (
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-1.5">
                          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                            <span
                              dir="auto"
                              data-roster-bot-name={item.kind === "bot" ? "" : undefined}
                              className={`max-w-full shrink-0 truncate text-body-sm text-foreground ${
                                item.chat.unread ? "font-semibold" : "font-medium"
                              }`}
                            >
                              {item.chat.name}
                            </span>
                            {item.chat.unread ? (
                              <span className="sr-only">
                                <Trans> (unread)</Trans>
                              </span>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            {item.woke ? (
                              <span
                                data-roster-woke
                                className="text-label font-medium text-foreground/75"
                              >
                                <Trans>Woke</Trans>
                              </span>
                            ) : !compact ? (
                              <span
                                data-roster-time
                                className="text-label text-faint-foreground tabular-nums"
                              >
                                {formatRosterTime(item.chat.updatedAt)}
                              </span>
                            ) : null}
                            {item.chat.unread ? (
                              <span
                                aria-hidden="true"
                                data-roster-unread-dot
                                className="inline-block h-2 w-2 rounded-full bg-unread"
                              />
                            ) : null}
                          </div>
                        </div>
                        {compact ? (
                          compactStatusLabel ? (
                            <div
                              dir="auto"
                              data-roster-status={
                                rowError
                                  ? "error"
                                  : item.kind === "bot"
                                    ? item.chat.status
                                    : undefined
                              }
                              className={`mt-0.5 flex items-center gap-1 text-label ${
                                rowError
                                  ? "font-medium text-destructive"
                                  : workStatusLabel
                                    ? "font-semibold text-status-working"
                                    : "font-medium text-foreground/75"
                              }`}
                            >
                              {rowError ? <CircleAlert size={12} aria-hidden="true" /> : null}
                              <span>{compactStatusLabel}</span>
                            </div>
                          ) : null
                        ) : (
                          <div
                            dir="auto"
                            data-roster-preview={!workStatusLabel ? "true" : undefined}
                            className={`mt-1 truncate text-label ${
                              workStatusLabel
                                ? "font-semibold text-status-working"
                                : item.chat.unread
                                  ? "font-medium text-foreground/75"
                                  : "text-muted-foreground"
                            }`}
                          >
                            {rosterLine}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </ContextMenuTrigger>
                );
                return (
                  <div
                    key={`${item.kind}:${item.chat.id}`}
                    className="group/row relative"
                    style={{
                      opacity: item.kind === "bot" && draggedBotId === item.chat.id ? 0.55 : 1,
                    }}
                  >
                    <ChatMenu
                      target={{ kind: item.kind, id: item.chat.id }}
                      state={chatMenu}
                      disabled={item.chat.spaceId !== bootstrapMe?.spaceId}
                    >
                      {mini ? (
                        <Tooltip>
                          <TooltipTrigger render={chatTrigger} />
                          <TooltipContent
                            side="inline-end"
                            sideOffset={8}
                            arrow={false}
                            className="w-64 max-w-64 flex-col items-stretch gap-1 rounded-xl border border-border bg-popover px-3 py-2.5 text-popover-foreground shadow-md"
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              {item.kind === "bot" ? (
                                <BotAvatar
                                  avatarSet={item.chat.avatarSet}
                                  color={item.chat.color}
                                  identity={item.chat.id}
                                  size={18}
                                  status={item.chat.status}
                                />
                              ) : (
                                <GroupAvatar members={groupMembers} size={18} />
                              )}
                              <span
                                dir="auto"
                                className="truncate text-body-sm font-medium text-foreground"
                              >
                                {item.chat.name}
                              </span>
                            </span>
                            {compactStatusLabel || previewLine ? (
                              <span
                                dir="auto"
                                className={`line-clamp-2 text-body-sm ${
                                  rowError
                                    ? "text-destructive"
                                    : workStatusLabel
                                      ? "font-medium text-status-working"
                                      : compactStatusLabel
                                        ? "font-medium text-foreground"
                                        : "text-muted-foreground"
                                }`}
                              >
                                {compactStatusLabel ?? previewLine}
                              </span>
                            ) : null}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        chatTrigger
                      )}
                    </ChatMenu>
                  </div>
                );
              })}
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </>
  );
}

/** A space section header's name as one phrase, for accessible labels. */
function headerName(group: { title?: string | null; subtitle?: string }): string {
  return group.subtitle ? `${group.title}, ${group.subtitle}` : (group.title ?? "");
}

function formatRosterTime(isoDate?: string | null): string {
  if (!isoDate) return "";
  try {
    const d = new Date(isoDate);
    if (Number.isNaN(d.getTime())) return "";
    const locale = i18n.locale || "en";
    const now = new Date();
    const isToday =
      d.getDate() === now.getDate() &&
      d.getMonth() === now.getMonth() &&
      d.getFullYear() === now.getFullYear();
    if (isToday) {
      return d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday =
      d.getDate() === yesterday.getDate() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getFullYear() === yesterday.getFullYear();
    if (isYesterday) return t`Yesterday`;
    const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays < 7) {
      return d.toLocaleDateString(locale, { weekday: "short" });
    }
    return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
