import { useLingui } from "@lingui/react/macro";
import type { RunActivityRow } from "@rakazo/contracts";
import { activitySections } from "@rakazo/core";
import type { Href } from "expo-router";
import type { ReactElement, ReactNode } from "react";
import { useMemo } from "react";
import { View } from "react-native";
import { activityPreview, activityStatusLabel, formatActivityRelativeTime } from "../lib/activity";
import type { InboxRowAction } from "../lib/inbox-swipe";
import { inboxRowActionList } from "../lib/inbox-swipe";
import type { MobileBot, MobileGroup } from "../lib/mobile-types";
import { useThemedStyles } from "../lib/native";
import { BotAvatar } from "./bot-avatar";
import { GroupAvatar } from "./group-avatar";
import { createHomeStyles } from "./home-styles";
import type { RowMenuProps } from "./inbox-rows";
import { ChatSwipe, ConversationRow, FALLBACK_COLOR, SectionToggle } from "./inbox-rows";

type SwipeTarget = { kind: "bot"; chat: MobileBot } | { kind: "group"; chat: MobileGroup };
type RowActions = { actions: InboxRowAction[]; onAction: (action: InboxRowAction) => void };

export type ActivitySwipe = RowMenuProps & {
  botAction: (action: InboxRowAction, bot: MobileBot) => void;
  groupAction: (action: InboxRowAction, group: MobileGroup) => void;
};

export function ActivitySection({
  activity,
  bots,
  groups,
  toggledSections,
  onToggleSection,
  openChat,
  swipe,
}: {
  activity: { active: RunActivityRow[]; recent: RunActivityRow[] };
  bots: MobileBot[];
  groups: MobileGroup[];
  /** Section keys flipped from their default fold, stored with the inbox's collapsed sections. */
  toggledSections: ReadonlySet<string>;
  onToggleSection: (key: string) => void;
  openChat: (href: Href) => void;
  swipe?: ActivitySwipe;
}) {
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useLingui();
  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const groupsById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  // Only chats in the inbox, so a chat archived from here leaves at once, like its inbox row.
  const inInbox = (run: RunActivityRow) =>
    run.groupId ? groupsById.has(run.groupId) : botsById.has(run.botId);
  const sections = activitySections({
    active: activity.active.filter(inInbox),
    recent: activity.recent.filter(inInbox),
    bots,
    groups,
  });
  // The inbox's swipe actions and menu.
  const swipeable = (target: SwipeTarget, row: (actions?: RowActions) => ReactElement) => {
    if (!swipe) return row();
    const onAction = (action: InboxRowAction) =>
      target.kind === "bot"
        ? swipe.botAction(action, target.chat)
        : swipe.groupAction(action, target.chat);
    return (
      <ChatSwipe
        key={`${target.kind}:${target.chat.id}`}
        target={target}
        rowKey={`activity:${target.kind}:${target.chat.id}`}
        onAction={onAction}
        sections={swipe.sections}
        onOrganize={swipe.onOrganize}
        onEditSection={swipe.onEditSection}
        onSnooze={swipe.onSnooze && ((until) => swipe.onSnooze?.(target.kind, target.chat, until))}
      >
        {row({ actions: inboxRowActionList(target.chat), onAction })}
      </ChatSwipe>
    );
  };
  const runTarget = (run: RunActivityRow): SwipeTarget => {
    const group = run.groupId ? groupsById.get(run.groupId) : undefined;
    return group
      ? { kind: "group", chat: group }
      : { kind: "bot", chat: botsById.get(run.botId) as MobileBot };
  };
  const openRun = (run: RunActivityRow) => {
    if (run.groupId) {
      openChat({
        pathname: "/group-thread",
        params: { groupId: run.groupId, name: run.groupName ?? t`Group` },
      });
      return;
    }
    openChat({ pathname: "/thread", params: { botId: run.botId, name: run.botName } });
  };
  const runRows = (runs: RunActivityRow[], detailed = false) =>
    runs.map((run) =>
      swipeable(runTarget(run), (actions) => (
        <ActivityRow
          key={run.runId}
          run={run}
          bot={botsById.get(run.botId)}
          detailed={detailed}
          onPress={() => openRun(run)}
          {...actions}
        />
      )),
    );
  const fold = (key: string, title: string, count: number, defaultOpen: boolean) => ({
    title,
    count,
    open: defaultOpen !== toggledSections.has(`activity:${key}`),
    onToggle: () => onToggleSection(`activity:${key}`),
  });
  const unreadCount = sections.unreadGroups.length + sections.unreadBots.length;

  if (
    sections.attention.length + sections.working.length + unreadCount + sections.recent.length ===
    0
  )
    return null;
  return (
    <View style={styles.activitySection}>
      {sections.attention.length > 0 ? (
        <Fold {...fold("attention", t`Needs attention`, sections.attention.length, true)}>
          {runRows(sections.attention)}
        </Fold>
      ) : null}
      {sections.working.length > 0 ? (
        <Fold {...fold("working", t`Working`, sections.working.length, false)}>
          {runRows(sections.working)}
        </Fold>
      ) : null}
      {unreadCount > 0 ? (
        <Fold {...fold("unread", t`Unread`, unreadCount, false)}>
          {sections.unreadGroups.map((group) =>
            swipeable({ kind: "group", chat: group }, (actions) => (
              <ConversationRow
                key={group.id}
                title={group.name}
                preview={group.preview}
                time={formatActivityRelativeTime(group.updatedAt)}
                accessibilityLabel={group.name}
                onPress={() =>
                  openChat({
                    pathname: "/group-thread",
                    params: { groupId: group.id, name: group.name },
                  })
                }
                avatar={<GroupAvatar members={group.members} />}
                {...actions}
              />
            )),
          )}
          {sections.unreadBots.map((bot) =>
            swipeable({ kind: "bot", chat: bot }, (actions) => (
              <ConversationRow
                key={bot.id}
                title={bot.name}
                preview={bot.preview}
                time={formatActivityRelativeTime(bot.updatedAt)}
                accessibilityLabel={bot.name}
                onPress={() =>
                  openChat({ pathname: "/thread", params: { botId: bot.id, name: bot.name } })
                }
                avatar={
                  <BotAvatar
                    identity={bot.id}
                    color={bot.color}
                    avatarSet={bot.avatarSet}
                    motion="lazy"
                  />
                }
                {...actions}
              />
            )),
          )}
        </Fold>
      ) : null}
      {sections.recent.length > 0 ? (
        <Fold {...fold("recent", t`Recent`, sections.recent.length, true)}>
          {runRows(sections.recent, true)}
        </Fold>
      ) : null}
    </View>
  );
}

function Fold({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const styles = useThemedStyles(createHomeStyles);
  return (
    <View>
      <View style={styles.sectionHeadingRow}>
        <SectionToggle title={title} count={count} collapsed={!open} onPress={onToggle} />
      </View>
      {open ? children : null}
    </View>
  );
}

function ActivityRow({
  run,
  bot,
  detailed,
  onPress,
  actions,
  onAction,
}: Partial<RowActions> & {
  run: RunActivityRow;
  bot?: MobileBot;
  /** Recent mixes outcomes, so its rows say how each run ended and when. */
  detailed: boolean;
  onPress: () => void;
}) {
  const status = activityStatusLabel(run.status);
  const snippet = activityPreview(run);
  const preview = detailed ? (snippet ? `${status}: ${snippet}` : status) : snippet;
  // Compact rows hide tags, so the group stays in the title.
  const title = [run.botName, run.groupName].filter(Boolean).join(", ");
  return (
    <ConversationRow
      title={title}
      preview={preview}
      time={detailed ? formatActivityRelativeTime(run.updatedAt) : ""}
      accessibilityLabel={`${title}, ${status}`}
      onPress={onPress}
      actions={actions}
      onAction={onAction}
      avatar={
        <BotAvatar
          identity={run.botId}
          color={bot?.color ?? FALLBACK_COLOR}
          avatarSet={bot?.avatarSet}
          status={run.status}
          motion="lazy"
        />
      }
    />
  );
}
