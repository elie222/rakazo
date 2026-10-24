import { MenuView } from "@expo/ui/community/menu";
import type { RunActivityRow, SpaceBot, SpaceGroup } from "@rakazo/contracts";
import { normalizeCreateBotProfile } from "@rakazo/contracts";
import { accountDisplay, isRetryableError, isRunWaitingOnUser, isRunWorking } from "@rakazo/core";
import { botColors, fontWeight, typeScale } from "@rakazo/ui-tokens";
import type { Href } from "expo-router";
import {
  Redirect,
  useFocusEffect,
  useGlobalSearchParams,
  useIsFocused,
  useNavigation,
  usePathname,
  useRouter,
} from "expo-router";
import type { ReactNode } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ViewToken } from "react-native";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar } from "../components/bot-avatar";
import type { BotOrganizationUpdate } from "../components/bot-organize-modal";
import { BotOrganizeModal } from "../components/bot-organize-modal";
import { GroupAvatar } from "../components/group-avatar";
import { HomeErrorState } from "../components/home-error-state";
import { InboxSwipeRow } from "../components/inbox-swipe-row";
import { NativeSymbol } from "../components/native-symbol";
import { useUnreadJumpPills } from "../components/unread-jump-overlay";
import {
  activityPreview,
  activityStatusLabel,
  fetchSpaceActivity,
  formatActivityRelativeTime,
} from "../lib/activity";
import { loadActivityMode, saveActivityMode } from "../lib/activity-mode";
import { readableGutters } from "../lib/adaptive-layout";
import type {
  ApiRequestContext,
  MobileBot,
  MobileBotSection,
  MobileGroup,
  MobileMe,
  MobileSpace,
  MobileSpaceNavigation,
} from "../lib/api";
import {
  captureApiRequestContext,
  currentApiBase,
  loadSessionToken,
  rpc,
  selectedSpaceId,
  selectInitialSpace,
  selectSpace,
  signOut,
} from "../lib/api";
import {
  appBadgeGeneration,
  forgetAppBadge,
  syncInboxAppBadge,
  unreadChatCount,
} from "../lib/app-badge";
import { mobileTokens, resolveMobileAppearance } from "../lib/appearance";
import {
  archivedChatCounts,
  loadAllArchivedChats as loadArchivedChats,
  notifyArchivedChatsChanged,
  onArchivedChatsChanged,
} from "../lib/archived-chats";
import { AvatarRow, AvatarViewportScope, createAvatarViewport } from "../lib/avatar-life";
import { confirmDeleteBot, confirmDeleteGroup } from "../lib/bot-lifecycle";
import type { CollapsedSections } from "../lib/collapsed-sections";
import { loadCollapsedSections, saveCollapsedSections } from "../lib/collapsed-sections";
import { confirmDeleteSection } from "../lib/confirm-delete-section";
import { useHeaderHeightIfAny } from "../lib/floating-header";
import { allowFocusPrompt, scheduleFocusPrompt } from "../lib/focus-prompt";
import { useForegroundPoll } from "../lib/foreground-poll";
import { t, useI18n } from "../lib/i18n";
import { botTag, formatThreadTime } from "../lib/inbox";
import { retainInboxValue } from "../lib/inbox-retention";
import type { InboxSpace, InboxSpaceItem } from "../lib/inbox-spaces";
import {
  canDeleteInboxSpace,
  inboxHasNoChats,
  inboxNeedsCreateHint,
  removeInboxSpace,
  retryInboxSpaceFallback,
  selectInboxSpace,
  spaceInboxItems,
} from "../lib/inbox-spaces";
import type { InboxChatKind, InboxRowAction } from "../lib/inbox-swipe";
import {
  applyUnreadOverrides,
  chatTarget,
  createLatestQueue,
  INBOX_ROW_ACTIONS,
  inboxRowActionList,
  unreadOverrideKey,
} from "../lib/inbox-swipe";
import { afterChatNotifyChange, dismissThreadNotifications } from "../lib/live-notifications";
import { native, useThemedStyles } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import type { InboxSignal } from "../lib/offscreen-unreads";
import { offerPasskeyOnce } from "../lib/passkey";
import { ACTIVITY_POLL_INTERVAL_MS, INBOX_POLL_INTERVAL_MS } from "../lib/poll-cadence";
import { previewSnippet } from "../lib/preview";
import { registerPushToken } from "../lib/push";
import { androidRipple } from "../lib/ripple";
import { loadSavedInbox, saveInbox } from "../lib/saved-chats";
import { setSearchInbox } from "../lib/search-inbox";
import { promptSectionName } from "../lib/section-name-prompt";
import {
  currentReadySessionGeneration,
  currentSessionGeneration,
  subscribeSessionGeneration,
} from "../lib/session";
import { useSplitView } from "../lib/split-view";
import { stacksAtTextScale } from "../lib/text-scale";
import type { LoadFailureKind } from "../lib/user-error";
import { errorText, loadFailureKind } from "../lib/user-error";

const FALLBACK_COLOR = botColors[3];
/** A row counts as on screen as soon as any of it shows. */
const AVATAR_VIEWABILITY = { itemVisiblePercentThreshold: 1 };
// A list narrower than this, beside an open chat, keeps names whole by leaving out the title tag.
const TAGLESS_LIST_WIDTH = 360;
const CompactRowsContext = createContext(false);
// The chat open beside the list, so its row can show as selected.
const SelectedChatContext = createContext<string | null>(null);
// Swipe actions and the context menu are iOS list behaviour; other platforms keep the long-press
// sheet.
const SWIPE_ROWS = Platform.OS === "ios";

type PinnedChat =
  | { kind: "bot"; bot: MobileBot | SpaceBot }
  | { kind: "group"; group: MobileGroup | SpaceGroup };
type InboxItem = InboxSpaceItem | { type: "pinned"; chats: PinnedChat[] };

/** What a chat adds to the off-screen unread pills: unread, and a bot waiting on you. */
function chatSignal(chat: PinnedChat): InboxSignal {
  return chat.kind === "bot"
    ? {
        unread: chat.bot.unread ? 1 : 0,
        attention: isRunWaitingOnUser(chat.bot.status) ? 1 : 0,
      }
    : { unread: chat.group.unread ? 1 : 0, attention: 0 };
}

function inboxItemKey(item: InboxItem): string {
  if (item.type === "pinned") return "pinned";
  if (item.type === "heading") return `heading-${item.key}`;
  if (item.type === "bot") return item.bot.id;
  return `group-${item.group.id}`;
}

function inboxSignal(item: InboxItem): InboxSignal {
  if (item.type === "heading") return { unread: 0, attention: 0 };
  if (item.type === "bot") return chatSignal({ kind: "bot", bot: item.bot });
  if (item.type === "group") return chatSignal({ kind: "group", group: item.group });
  return item.chats.map(chatSignal).reduce(
    (total, signal) => ({
      unread: total.unread + signal.unread,
      attention: total.attention + signal.attention,
    }),
    { unread: 0, attention: 0 },
  );
}

async function openMobileSpace(spaceId: string | undefined, open: () => void) {
  if (spaceId && !(await selectSpace(spaceId))) {
    Alert.alert(t("Could not switch spaces"), t("Try again."));
    return;
  }
  open();
}

/** Sends a request about a chat to that chat's space without switching to it. */
async function chatRequestContext(
  spaceId: string | undefined,
): Promise<ApiRequestContext | undefined> {
  if (!spaceId || spaceId === selectedSpaceId()) return undefined;
  const context = await captureApiRequestContext();
  return { ...context, headers: { ...context.headers, "x-rakazo-space-id": spaceId } };
}

async function chatRpc(spaceId: string | undefined, proc: string, body: unknown) {
  const requestContext = await chatRequestContext(spaceId);
  return requestContext
    ? rpc(proc, body, { requestContext, skipSpaceAuthRecovery: true })
    : rpc(proc, body);
}

export default function HomeRoute() {
  const { split } = useSplitView();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useI18n();
  useLayoutEffect(() => {
    // Home restores its native controls when the compact inbox mounts again.
    if (split) navigation.setOptions({ headerShown: false });
  }, [split, navigation]);
  return split ? (
    <View
      style={[
        styles.screen,
        styles.centered,
        {
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        },
      ]}
    >
      <Text style={styles.emptyPane}>{t("Pick a chat")}</Text>
    </View>
  ) : (
    <HomeSession />
  );
}

/** The chat list beside the open chat on a wide window. */
type InboxPaneProps = {
  onSelectSpace?: (spaceId: string) => void;
  onShareSelect?: (bot: MobileBot | SpaceBot) => void;
};

export function InboxPane({ onSelectSpace, onShareSelect }: InboxPaneProps) {
  return <HomeSession embedded onSelectSpace={onSelectSpace} onShareSelect={onShareSelect} />;
}

export function HomeSession({
  embedded = false,
  onSelectSpace,
  onShareSelect,
}: InboxPaneProps & { embedded?: boolean }) {
  const generation = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  const ready = useSyncExternalStore(subscribeSessionGeneration, currentReadySessionGeneration);
  return (
    <Home
      key={`${generation}:${ready}`}
      embedded={embedded}
      onSelectSpace={onSelectSpace}
      onShareSelect={onShareSelect}
    />
  );
}

function Home({ embedded, onSelectSpace, onShareSelect }: InboxPaneProps & { embedded: boolean }) {
  const tokens = mobileTokens();
  const appearance = resolveMobileAppearance();
  const styles = useThemedStyles(createHomeStyles);
  const { t, locale } = useI18n();
  const isFocused = useIsFocused();
  const [day, setDay] = useState(() => new Date().setHours(0, 0, 0, 0));
  useFocusEffect(
    useCallback(() => {
      let timer: ReturnType<typeof setTimeout>;
      const refreshDay = () => {
        clearTimeout(timer);
        const now = new Date();
        setDay(new Date(now).setHours(0, 0, 0, 0));
        const midnight = new Date(now);
        midnight.setHours(24, 0, 0, 0);
        timer = setTimeout(refreshDay, midnight.getTime() - now.getTime());
      };
      refreshDay();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") refreshDay();
      });
      return () => {
        clearTimeout(timer);
        subscription.remove();
      };
    }, []),
  );
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [groups, setGroups] = useState<MobileGroup[]>([]);
  const [botSections, setBotSections] = useState<MobileBotSection[]>([]);
  const [spaces, setSpaces] = useState<MobileSpace[]>([]);
  const [me, setMe] = useState<Pick<MobileMe, "userId" | "spaceId" | "name"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept apart from action errors so a failed action never borrows the load's title.
  const [inboxLoading, setInboxLoading] = useState(false);
  const [loadFailure, setLoadFailure] = useState<{ kind: LoadFailureKind; message: string } | null>(
    null,
  );
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [unreadOverrides, setUnreadOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const [organizeTarget, setOrganizeTarget] = useState<{
    kind: "bot" | "group";
    id: string;
    spaceId?: string;
    chat: MobileBot | MobileGroup | SpaceBot | SpaceGroup;
    sections: MobileBotSection[];
  } | null>(null);
  const organizeRequestId = useRef(0);
  const [archived, setArchived] = useState({ spaceId: "", count: 0 });
  // All spaces’ archived chats; a list that fails to load keeps its last count.
  const archivedCounts = useRef({ spaceId: "", bots: 0, groups: 0 });
  const archivedRequestId = useRef(0);
  const [activityMode, setActivityMode] = useState(false);
  const [activity, setActivity] = useState<{ active: RunActivityRow[]; recent: RunActivityRow[] }>({
    active: [],
    recent: [],
  });
  const activityRequestId = useRef(0);
  const inboxRequestId = useRef(0);
  const inboxLoaded = useRef(false);
  const creatingBotRef = useRef(false);
  const spaceActionRef = useRef<{ busy: boolean; recoveryId: string | null }>({
    busy: false,
    recoveryId: null,
  });
  const [spaceBusy, setSpaceBusy] = useState(false);
  const [spaceRecoveryId, setSpaceRecoveryId] = useState<string | null>(null);
  // Roster parent bot ids and section heading keys, kept on this device for the last account
  // that changed them. Loaded before the inbox first renders, so sections don't fold on launch.
  const [collapsedSections, setCollapsedSections] = useState<CollapsedSections>(() => ({
    keys: new Set(),
  }));
  const userId = me?.userId;
  const collapsed = useMemo(
    () => (collapsedSections.userId === userId ? collapsedSections.keys : new Set<string>()),
    [collapsedSections, userId],
  );
  const toggleCollapsed = useCallback(
    (key: string) => {
      setCollapsedSections((previous) => {
        const next = new Set(previous.userId === userId ? previous.keys : []);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return { userId, keys: next };
      });
    },
    [userId],
  );
  useEffect(() => {
    if (collapsedSections.userId) {
      saveCollapsedSections(collapsedSections.userId, collapsedSections.keys);
    }
  }, [collapsedSections]);

  useEffect(() => {
    void loadActivityMode().then(setActivityMode);
  }, []);

  // Only while the inbox is in front, so the offer waits until signup setup is done.
  useFocusEffect(
    useCallback(() => {
      if (!userId) return;
      let active = true;
      void offerPasskeyOnce(userId, () => active);
      return () => {
        active = false;
      };
    }, [userId]),
  );

  const toggleActivityMode = useCallback(() => {
    setActivityMode((on) => {
      const next = !on;
      void saveActivityMode(next);
      return next;
    });
  }, []);

  const [badgeLoad, setBadgeLoad] = useState<{ generation: number } | null>(null);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") forgetAppBadge();
    });
    return () => subscription.remove();
  }, []);

  const loadBots = useCallback(async () => {
    const badgeGeneration = appBadgeGeneration();
    if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
    const requestId = ++inboxRequestId.current;
    const apiBase = currentApiBase();
    const generation = currentSessionGeneration();
    setError(null);
    setInboxLoading(true);
    try {
      const [navigation, nextMe] = await Promise.all([
        rpc<MobileSpaceNavigation>("spaces/list"),
        rpc<MobileMe>("me"),
      ]);
      if (
        requestId !== inboxRequestId.current ||
        generation !== currentSessionGeneration() ||
        apiBase !== currentApiBase()
      )
        return;
      if (!(await selectInitialSpace(nextMe.spaceId))) {
        throw new Error(t("Could not save the default space"));
      }
      if (
        requestId !== inboxRequestId.current ||
        generation !== currentSessionGeneration() ||
        apiBase !== currentApiBase()
      )
        return;
      if (nextMe.billingEnabled) {
        void rpc<{ access: boolean; funding?: string | null }>("billing/status")
          .then((billing) => {
            if (
              requestId === inboxRequestId.current &&
              generation === currentSessionGeneration() &&
              apiBase === currentApiBase() &&
              billing.funding !== undefined &&
              !billing.access
            )
              router.push("/billing");
          })
          .catch(() => undefined);
      }
      setBots((current) => retainInboxValue(current, navigation.current.bots));
      setBotSections((current) => retainInboxValue(current, navigation.current.botSections));
      setGroups((current) => retainInboxValue(current, navigation.current.groups));
      setSpaces((current) => retainInboxValue(current, navigation.spaces));
      setMe((current) => retainInboxValue(current, nextMe));
      inboxLoaded.current = true;
      setBadgeLoad({ generation: badgeGeneration });
      setLoadFailure(null);
      saveInbox(
        {
          apiBase,
          userId: nextMe.userId,
          spaceId: navigation.current.id,
          sessionGeneration: generation,
          selectionId: selectedSpaceId(),
        },
        navigation,
        nextMe,
      );
      return true;
    } catch (err) {
      if (
        requestId !== inboxRequestId.current ||
        generation !== currentSessionGeneration() ||
        apiBase !== currentApiBase()
      )
        return;
      setLoadFailure({
        kind: loadFailureKind(err),
        message: errorText(err, t("Could not load bots")),
      });
      // False when the server refused rather than failed: asking again only polls it.
      return isRetryableError(err);
    } finally {
      if (requestId === inboxRequestId.current) setInboxLoading(false);
    }
  }, []);

  const refreshBots = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadBots();
    } finally {
      setRefreshing(false);
    }
  }, [loadBots]);

  useEffect(() => {
    void Promise.all([loadSessionToken(), loadCollapsedSections()]).then(([token, stored]) => {
      if (stored) setCollapsedSections(stored);
      setHasSession(Boolean(token));
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!hasSession || onShareSelect) return;
    void registerPushToken().catch(() => undefined);
  }, [hasSession, onShareSelect]);

  // Show the inbox saved on this device until the first live load replaces it.
  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    void loadSavedInbox().then((saved) => {
      if (cancelled || !saved || inboxLoaded.current) return;
      setBots(saved.bots);
      setBotSections(saved.botSections);
      setGroups(saved.groups);
      setSpaces(saved.spaces);
      setMe(saved.me);
    });
    return () => {
      cancelled = true;
    };
  }, [hasSession]);

  // The embedded pane is visible beside the chat, so it keeps polling even when
  // the chat route owns focus.
  useForegroundPoll(loadBots, INBOX_POLL_INTERVAL_MS, hasSession && (embedded || isFocused));

  const spaceId = me?.spaceId;
  // Another space's count never shows while this space's is loading.
  const archivedCount = archived.spaceId === spaceId ? archived.count : 0;
  const loadArchivedCount = useCallback(async () => {
    if (!spaceId) return;
    const requestId = ++archivedRequestId.current;
    const loaded = await loadArchivedChats();
    if (requestId !== archivedRequestId.current) return;
    const previous =
      archivedCounts.current.spaceId === spaceId ? archivedCounts.current : { bots: 0, groups: 0 };
    archivedCounts.current = { spaceId, ...archivedChatCounts(previous, loaded) };
    setArchived({ spaceId, count: archivedCounts.current.bots + archivedCounts.current.groups });
  }, [spaceId]);
  // Not part of the poll: the count changes only through archive and restore, which signal it.
  useFocusEffect(
    useCallback(() => {
      if (!hasSession) return;
      void loadArchivedCount();
      return onArchivedChatsChanged(() => void loadArchivedCount());
    }, [hasSession, loadArchivedCount]),
  );

  const loadActivity = useCallback(async () => {
    if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
    if (!hasSession || !activityMode) {
      activityRequestId.current += 1;
      setActivity({ active: [], recent: [] });
      return;
    }
    const requestId = ++activityRequestId.current;
    try {
      const next = await fetchSpaceActivity();
      if (requestId !== activityRequestId.current) return;
      setActivity(next);
    } catch (error) {
      // Keep the last good snapshot on transient RPC failures; only drop stale responses.
      if (requestId !== activityRequestId.current) return;
      // False when the server refused rather than failed: asking again only polls it.
      return isRetryableError(error);
    }
  }, [activityMode, hasSession]);

  useForegroundPoll(
    loadActivity,
    ACTIVITY_POLL_INTERVAL_MS,
    hasSession && activityMode && (embedded || isFocused),
  );

  useEffect(
    () => () => {
      activityRequestId.current += 1;
    },
    [activityMode, hasSession],
  );

  const visible = useMemo(
    () => applyUnreadOverrides("bot", bots, unreadOverrides),
    [bots, unreadOverrides],
  );
  const visibleGroups = useMemo(
    () => applyUnreadOverrides("group", groups, unreadOverrides),
    [groups, unreadOverrides],
  );
  const inboxSpaces = useMemo(
    () =>
      spaces.length > 0
        ? spaces.map((space) =>
            space.id === me?.spaceId
              ? { ...space, bots: visible, groups: visibleGroups, botSections }
              : space,
          )
        : me
          ? [
              {
                id: me.spaceId,
                name: t("Personal"),
                isDefault: true,
                hasContent: true,
                bots: visible,
                groups: visibleGroups,
                botSections,
              },
            ]
          : [],
    [spaces, me, visible, visibleGroups, botSections, t, locale],
  );
  useEffect(() => {
    // A remounted session has no roster until its saved or live inbox arrives.
    if (me) setSearchInbox(inboxSpaces);
  }, [inboxSpaces, me]);
  const listData = useMemo((): InboxItem[] => {
    // Only bot threads support importing shares; use the same rows for every target.
    if (onShareSelect)
      return spaceInboxItems(
        inboxSpaces
          .filter((space) => space.bots.length > 0)
          .map((space) => ({ ...space, groups: [] })),
        collapsed,
      );
    // Android pins sit above the list; iOS keeps rows with native swipe and context menus.
    const otherSpaces = spaces.filter((space) => space.id !== me?.spaceId);
    const pinned: PinnedChat[] = [
      ...[...visible, ...otherSpaces.flatMap((space) => space.bots)]
        .filter((bot) => bot.pinned)
        .map((bot) => ({ kind: "bot" as const, bot })),
      ...[...visibleGroups, ...otherSpaces.flatMap((space) => space.groups)]
        .filter((group) => group.pinned)
        .map((group) => ({ kind: "group" as const, group })),
    ];
    const sidebarSpaces = inboxSpaces.map((space) => ({
      ...space,
      bots: space.bots.filter((bot) => SWIPE_ROWS || !bot.pinned),
      groups: space.groups.filter((group) => SWIPE_ROWS || !group.pinned),
    }));
    const items: InboxItem[] = spaceInboxItems(sidebarSpaces, collapsed, me?.spaceId);
    return !SWIPE_ROWS && pinned.length > 0 ? [{ type: "pinned", chats: pinned }, ...items] : items;
  }, [inboxSpaces, collapsed, me?.spaceId, spaces, visible, visibleGroups, locale, onShareSelect]);
  const badgeCount = me ? unreadChatCount(inboxSpaces) : null;
  useEffect(() => {
    if (badgeCount === null || badgeLoad === null) return;
    void syncInboxAppBadge(badgeCount, badgeLoad.generation);
  }, [badgeCount, badgeLoad]);
  const initials = accountDisplay(me ?? {}, t("You")).initial ?? "?";
  const organizeSpace = organizeTarget
    ? organizeTarget.spaceId === me?.spaceId
      ? { bots, groups, botSections }
      : spaces.find((space) => space.id === organizeTarget.spaceId)
    : undefined;
  const organizeChat = organizeTarget
    ? organizeTarget.kind === "bot"
      ? (organizeSpace?.bots.find((bot) => bot.id === organizeTarget.id) ?? organizeTarget.chat)
      : (organizeSpace?.groups.find((group) => group.id === organizeTarget.id) ??
        organizeTarget.chat)
    : null;
  const insets = useSafeAreaInsets();
  // An unfolded or tablet window keeps the inbox in a centred column.
  const windowWidth = useWindowDimensions().width;
  const { inboxWidth } = useSplitView();
  const compactRows = embedded && inboxWidth < TAGLESS_LIST_WIDTH;
  const columnInsets = readableGutters(embedded ? inboxWidth : windowWidth, {
    left: insets.left,
    right: embedded ? 0 : insets.right,
  });
  // Liquid Glass uses the native bar: glass bar items and a native menu.
  // The list beside a chat has no navigation bar of its own.
  const nativeHeader = iosAtLeast(26) && !embedded;
  const headerHeight = useHeaderHeightIfAny();
  const listRef = useRef<FlatList<InboxItem>>(null);
  const jumpSignals = useMemo(() => listData.map(inboxSignal), [listData]);
  const jumpKeys = useMemo(() => listData.map(inboxItemKey), [listData]);
  const unreadJump = useUnreadJumpPills({
    signals: jumpSignals,
    keys: jumpKeys,
    listRef,
    // The Liquid Glass header floats over the list; the older header sits above it.
    topInset: nativeHeader ? headerHeight : 0,
    bottomInset: insets.bottom,
  });
  const navigation = useNavigation();
  const router = useRouter();
  const pathname = usePathname();
  const openParams = useGlobalSearchParams<{ botId?: string; groupId?: string }>();
  const selectedChatId =
    pathname === "/thread"
      ? (openParams.botId ?? null)
      : pathname === "/group-thread"
        ? (openParams.groupId ?? null)
        : null;
  // Beside the list, a chat replaces the open one instead of stacking on it.
  const openChat = useCallback(
    (href: Href) => {
      if (!embedded) router.push(href);
      else if (pathname === "/thread" || pathname === "/group-thread") router.replace(href);
      else {
        if (router.canDismiss()) router.dismissAll();
        router.push(href);
      }
    },
    [embedded, pathname, router],
  );
  const signInAgain = useCallback(async () => {
    // A rejected session cannot sign out on the server; clearing it here is what matters.
    await signOut().catch(() => undefined);
    router.replace("/sign-in");
  }, [router]);

  const chooseInboxSpace = useCallback(
    async (spaceId: string) => {
      if (spaceActionRef.current.busy) return;
      spaceActionRef.current.busy = true;
      setSpaceBusy(true);
      inboxRequestId.current += 1;
      activityRequestId.current += 1;
      setActivity({ active: [], recent: [] });
      // Close a pane in another space before selection can change its request context.
      onSelectSpace?.(spaceId);
      try {
        const refresh = async () => {
          spaceActionRef.current.recoveryId = null;
          setSpaceRecoveryId(null);
          spaceActionRef.current.busy = false;
          await refreshBots();
          await loadActivity();
        };
        const selected =
          spaceActionRef.current.recoveryId === spaceId
            ? await retryInboxSpaceFallback(spaceId, refresh)
            : await selectInboxSpace(spaceId, refresh);
        if (!selected) throw new Error(t("Could not switch spaces"));
      } catch (err) {
        const message = errorText(err, t("Could not switch spaces"));
        setError(message);
        Alert.alert(message, t("Try again."));
      } finally {
        spaceActionRef.current.busy = false;
        setSpaceBusy(false);
      }
    },
    [refreshBots, loadActivity, onSelectSpace, t],
  );

  const deleteInboxSpace = useCallback(
    async (space: InboxSpace) => {
      if (
        !canDeleteInboxSpace(space) ||
        spaceActionRef.current.busy ||
        spaceActionRef.current.recoveryId
      )
        return;
      spaceActionRef.current.busy = true;
      setSpaceBusy(true);
      inboxRequestId.current += 1;
      activityRequestId.current += 1;
      try {
        const recoveryId = await removeInboxSpace(space.id, async () => {
          spaceActionRef.current.busy = false;
          setActivity({ active: [], recent: [] });
          await refreshBots();
          await loadActivity();
        });
        if (recoveryId) {
          spaceActionRef.current.recoveryId = recoveryId;
          setSpaceRecoveryId(recoveryId);
          setError(t("Could not switch spaces"));
        }
      } catch (err) {
        Alert.alert(t("Could not delete space"), errorText(err, t("Try again.")));
      } finally {
        spaceActionRef.current.busy = false;
        setSpaceBusy(false);
      }
    },
    [refreshBots, loadActivity, t],
  );

  const confirmDeleteSpace = useCallback(
    (space: InboxSpace) => {
      if (
        !canDeleteInboxSpace(space) ||
        spaceActionRef.current.busy ||
        spaceActionRef.current.recoveryId
      )
        return;
      Alert.alert(
        t("Delete {name}?", { name: space.name }),
        t("This removes the empty space for everyone."),
        [
          { text: t("Cancel"), style: "cancel" },
          {
            text: t("Delete"),
            style: "destructive",
            onPress: () => void deleteInboxSpace(space),
          },
        ],
      );
    },
    [deleteInboxSpace, t],
  );

  const createQuickBot = useCallback(async () => {
    if (creatingBotRef.current || spaceActionRef.current.busy || spaceActionRef.current.recoveryId)
      return;
    creatingBotRef.current = true;
    try {
      // Authoritative roster so a slow home fetch does not treat later bots as first.
      // A failed list is unknown — use the delayed path rather than assuming first.
      const existing = await rpc<MobileBot[]>("bots/list").catch(() => null);
      const isFirstBot = existing !== null && existing.length === 0;
      const bot = await rpc<MobileBot>("bots/create", {
        ...normalizeCreateBotProfile({ name: "New Bot", title: "", description: "" }),
        notifyOnFinish: true,
        computerMode: "team",
      });
      void refreshBots().catch(() => undefined);
      allowFocusPrompt(bot.id);
      openChat({ pathname: "/thread", params: { botId: bot.id, name: bot.name } });
      void (async () => {
        const started = await rpc("onboarding/start", { botId: bot.id })
          .then(() => true)
          .catch(() => false);
        if (!started) return;
        scheduleFocusPrompt(bot.id, isFirstBot);
      })();
    } catch (err) {
      setError(errorText(err, t("Could not create bot")));
    } finally {
      creatingBotRef.current = false;
    }
  }, [openChat, refreshBots, t]);

  const runCreateAction = useCallback(
    (action: "bot" | "group" | "space") => {
      if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
      if (action === "bot") void createQuickBot();
      else if (action === "group") router.push("/new-group");
      else router.push("/new-space");
    },
    [createQuickBot, router],
  );

  const openCreateChooser = useCallback(() => {
    Alert.alert(
      t("Create"),
      undefined,
      [
        { text: t("New bot"), onPress: () => runCreateAction("bot") },
        { text: t("New group"), onPress: () => runCreateAction("group") },
        { text: t("New space"), onPress: () => runCreateAction("space") },
      ],
      { cancelable: true },
    );
  }, [runCreateAction, t]);

  useLayoutEffect(() => {
    if (!nativeHeader) return;
    const signedIn = ready && hasSession;
    navigation.setOptions({
      headerShown: signedIn,
      headerTransparent: true,
      headerStyle: { backgroundColor: "transparent" },
      title: "",
      unstable_headerLeftItems: () => [
        {
          type: "button" as const,
          label: t("Account"),
          icon: { type: "sfSymbol" as const, name: "person.crop.circle" },
          accessibilityLabel: t("Account"),
          onPress: () => router.push("/account"),
        },
      ],
      unstable_headerRightItems: () => [
        {
          type: "button" as const,
          label: t("Activity"),
          accessibilityLabel: t("Activity"),
          icon: { type: "sfSymbol" as const, name: activityMode ? "bell.fill" : "bell" },
          selected: activityMode,
          onPress: toggleActivityMode,
        },
        {
          type: "button" as const,
          label: t("Search"),
          accessibilityLabel: t("Search"),
          identifier: "home-search-button",
          icon: { type: "sfSymbol" as const, name: "magnifyingglass" },
          onPress: () => router.push("/search"),
        },
        {
          type: "menu" as const,
          label: t("Create"),
          accessibilityLabel: t("Create"),
          icon: { type: "sfSymbol" as const, name: "plus" },
          menu: {
            items: [
              {
                type: "action" as const,
                label: t("New bot"),
                icon: { type: "sfSymbol" as const, name: "person.crop.circle.badge.plus" },
                onPress: () => runCreateAction("bot"),
              },
              {
                type: "action" as const,
                label: t("New group"),
                icon: { type: "sfSymbol" as const, name: "person.2" },
                onPress: () => runCreateAction("group"),
              },
              {
                type: "action" as const,
                label: t("New space"),
                icon: { type: "sfSymbol" as const, name: "square.grid.2x2" },
                onPress: () => runCreateAction("space"),
              },
            ],
          },
        },
      ],
    });
  }, [
    nativeHeader,
    navigation,
    ready,
    hasSession,
    initials,
    activityMode,
    toggleActivityMode,
    runCreateAction,
    router,
    t,
    locale,
  ]);

  const openBot = useCallback(
    (bot: MobileBot | SpaceBot) => {
      if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
      void openMobileSpace(bot.spaceId, () => {
        if (onShareSelect) onShareSelect(bot);
        else openChat({ pathname: "/thread", params: { botId: bot.id, name: bot.name } });
      });
    },
    [openChat, onShareSelect],
  );
  const openGroup = useCallback(
    (group: MobileGroup | SpaceGroup) => {
      if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
      void openMobileSpace(group.spaceId, () =>
        openChat({ pathname: "/group-thread", params: { groupId: group.id, name: group.name } }),
      );
    },
    [openChat],
  );
  const organize = useCallback(
    async (kind: "bot" | "group", chat: MobileBot | MobileGroup | SpaceBot | SpaceGroup) => {
      const requestId = ++organizeRequestId.current;
      const generation = currentSessionGeneration();
      const apiBase = currentApiBase();
      const spaceId = chat.spaceId ?? me?.spaceId;
      let space =
        spaceId === me?.spaceId
          ? { bots, groups, botSections }
          : spaces.find((space) => space.id === spaceId);
      let target = (kind === "bot" ? space?.bots : space?.groups)?.find(
        (item) => item.id === chat.id,
      );
      if (!target && spaceId) {
        try {
          // Independent of inbox polling: only a newer organize press supersedes this request.
          const context = await captureApiRequestContext();
          const navigation = await rpc<MobileSpaceNavigation>("spaces/list", undefined, {
            requestContext: {
              ...context,
              headers: { ...context.headers, "x-rakazo-space-id": spaceId },
            },
            skipSpaceAuthRecovery: true,
          });
          if (navigation.current.id !== spaceId) return;
          space = navigation.current;
          target = (kind === "bot" ? space.bots : space.groups).find((item) => item.id === chat.id);
        } catch (err) {
          if (
            requestId === organizeRequestId.current &&
            generation === currentSessionGeneration() &&
            apiBase === currentApiBase()
          ) {
            Alert.alert(t("Could not load bots"), errorText(err, t("Try again.")));
          }
          return;
        }
      }
      if (
        !space ||
        !target ||
        requestId !== organizeRequestId.current ||
        generation !== currentSessionGeneration() ||
        apiBase !== currentApiBase()
      )
        return;
      setOrganizeTarget({ kind, id: chat.id, spaceId, chat: target, sections: space.botSections });
      void loadBots();
    },
    [bots, groups, botSections, spaces, me?.spaceId, loadBots, t],
  );
  const organizeBot = useCallback(
    (bot: MobileBot | SpaceBot) => {
      void organize("bot", bot);
    },
    [organize],
  );
  const organizeGroup = useCallback(
    (group: MobileGroup | SpaceGroup) => {
      void organize("group", group);
    },
    [organize],
  );
  // One path for the long-press sheet and the swipe actions.
  const [sendReadState] = useState(() => createLatestQueue<boolean>());
  const updateChat = useCallback(
    async (
      kind: InboxChatKind,
      chat: MobileBot | MobileGroup | SpaceBot | SpaceGroup,
      update: BotOrganizationUpdate,
    ) => {
      await chatRpc(chat.spaceId, `${kind}s/update`, { ...chatTarget(kind, chat.id), ...update });
      if (kind === "bot" && update.notifyOnFinish !== undefined) {
        await afterChatNotifyChange(
          currentApiBase(),
          await loadSessionToken(),
          selectedSpaceId() ?? "",
          {
            threadId: "threadId" in chat ? chat.threadId : undefined,
            notify: update.notifyOnFinish,
          },
        );
      }
      await loadBots();
    },
    [loadBots],
  );
  const runRowAction = useCallback(
    async (
      kind: InboxChatKind,
      chat: MobileBot | MobileGroup | SpaceBot | SpaceGroup,
      action: InboxRowAction,
    ) => {
      if (action === "read" || action === "unread") {
        const key = unreadOverrideKey(kind, chat.id);
        // Queued changes belong to the session and the chat's own Space.
        const spaceId = chat.spaceId ?? selectedSpaceId();
        const session = currentSessionGeneration();
        setUnreadOverrides((current) => new Map(current).set(key, action === "unread"));
        if (action === "read") {
          void dismissThreadNotifications(
            kind === "group"
              ? { groupId: chat.id }
              : "threadId" in chat && chat.threadId
                ? { threadId: chat.threadId }
                : { botId: chat.id },
          ).catch(() => undefined);
        }
        await sendReadState(
          key,
          action === "unread",
          async (unread) => {
            const context = await captureApiRequestContext();
            if (context.sessionGeneration !== session) return;
            const headers = { ...context.headers };
            if (spaceId) headers["x-rakazo-space-id"] = spaceId;
            else delete headers["x-rakazo-space-id"];
            await rpc(
              unread ? "threads/markUnread" : "threads/markRead",
              chatTarget(kind, chat.id),
              { requestContext: { ...context, headers } },
            );
            const mark = <T extends { id: string; unread: boolean }>(chats: T[]) =>
              chats.map((item) => (item.id === chat.id ? { ...item, unread } : item));
            if (kind === "bot") setBots(mark);
            else setGroups(mark);
            await loadBots();
          },
          // The override stays until the last queued change for this chat is done.
          () =>
            setUnreadOverrides((current) => {
              const next = new Map(current);
              next.delete(key);
              return next;
            }),
        ).catch((err) => {
          // A change from a session that has since ended is dropped quietly.
          if (session !== currentSessionGeneration()) return;
          Alert.alert(t("Could not update chat"), errorText(err, t("Try again.")));
        });
        return;
      }
      if (action === "archive") {
        try {
          await chatRpc(chat.spaceId, `${kind}s/archive`, chatTarget(kind, chat.id));
          notifyArchivedChatsChanged();
        } catch (err) {
          Alert.alert(
            kind === "bot" ? t("Could not archive bot") : t("Could not update chat"),
            errorText(err, t("Try again.")),
          );
        }
        await loadBots();
        return;
      }
      // The same confirmation as the chat's own menu; the row goes once the server deletes it.
      if (action === "delete") {
        const deleted = () => {
          notifyArchivedChatsChanged();
          void loadBots();
        };
        if (kind === "bot") confirmDeleteBot({ id: chat.id, name: chat.name }, deleted);
        else confirmDeleteGroup({ id: chat.id, name: chat.name }, deleted);
        return;
      }
      await updateChat(kind, chat, { pinned: action === "pin" }).catch((err) =>
        Alert.alert(t("Could not update chat"), errorText(err, t("Try again."))),
      );
    },
    [loadBots, sendReadState, t, updateChat],
  );
  const botAction = useCallback(
    (action: InboxRowAction, bot: MobileBot | SpaceBot) => void runRowAction("bot", bot, action),
    [runRowAction],
  );
  const groupAction = useCallback(
    (action: InboxRowAction, group: MobileGroup | SpaceGroup) =>
      void runRowAction("group", group, action),
    [runRowAction],
  );
  const createSection = useCallback(
    async (kind: InboxChatKind, chatId: string, name: string, spaceId?: string) => {
      await chatRpc(spaceId, "botSections/create", { [`${kind}Id`]: chatId, name });
      await loadBots();
    },
    [loadBots],
  );
  const renameSection = useCallback(
    async (sectionId: string, name: string, spaceId?: string) => {
      await chatRpc(spaceId, "botSections/update", { sectionId, name });
      await loadBots();
    },
    [loadBots],
  );
  // The iOS row menu changes the chat in place, so failures use the native alert.
  const organizeFromMenu = useCallback(
    (
      kind: InboxChatKind,
      chat: MobileBot | MobileGroup | SpaceBot | SpaceGroup,
      update: BotOrganizationUpdate,
    ) =>
      void updateChat(kind, chat, update).catch((err) =>
        Alert.alert(t("Could not update chat"), errorText(err, t("Try again."))),
      ),
    [t, updateChat],
  );
  const editSectionFromMenu = useCallback(
    (
      kind: InboxChatKind,
      chat: MobileBot | MobileGroup | SpaceBot | SpaceGroup,
      mode: "create" | "rename",
    ) => {
      const current =
        mode === "rename" ? botSections.find((section) => section.id === chat.sectionId) : null;
      if (mode === "rename" && !current) return;
      promptSectionName({
        title: current ? t("Rename section") : t("New section"),
        cancelLabel: t("Cancel"),
        submitLabel: current ? t("Save") : t("Create"),
        defaultValue: current?.name,
        onSubmit: (name) =>
          void (
            current ? renameSection(current.id, name) : createSection(kind, chat.id, name)
          ).catch((err) =>
            Alert.alert(t("Could not update chat"), errorText(err, t("Try again."))),
          ),
      });
    },
    [botSections, createSection, renameSection, t],
  );

  const deleteSection = useCallback(
    (section: { id: string; name: string }) => {
      confirmDeleteSection(section, t, () => {
        void (async () => {
          try {
            await rpc("botSections/remove", { sectionId: section.id });
            await loadBots();
          } catch (err) {
            Alert.alert(t("Could not delete section"), errorText(err, t("Try again.")));
          }
        })();
      });
    },
    [loadBots, t],
  );

  const [avatarViewport] = useState(createAvatarViewport);
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) =>
    avatarViewport.update(viewableItems.map((token) => token.key)),
  ).current;
  const renderItem = useCallback(
    ({ item }: { item: InboxItem }) =>
      item.type === "pinned" ? (
        // The pinned tiles' avatars freeze with their row when it scrolls away.
        <AvatarRow id={inboxItemKey(item)}>
          <PinnedTiles
            chats={item.chats}
            onOpenBot={openBot}
            onOpenGroup={openGroup}
            onLongPressBot={organizeBot}
            onLongPressGroup={organizeGroup}
            onBotAction={botAction}
            onGroupAction={groupAction}
          />
        </AvatarRow>
      ) : item.type === "heading" ? (
        item.space ? (
          <View style={styles.spaceHeading}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={item.title}
              accessibilityState={{
                selected: item.space.id === me?.spaceId,
                disabled: spaceBusy,
              }}
              disabled={spaceBusy}
              onPress={() => {
                if (item.space) void chooseInboxSpace(item.space.id);
              }}
              style={({ pressed }) => [styles.spaceSelect, pressed && styles.rowPressed]}
            >
              <Text style={styles.spaceTitle}>{item.title}</Text>
            </Pressable>
            {!onShareSelect && canDeleteInboxSpace(item.space) ? (
              <MenuView
                actions={[
                  {
                    id: "delete",
                    title: t("Delete space"),
                    image: "trash",
                    attributes: { destructive: true, disabled: spaceBusy || !!spaceRecoveryId },
                  },
                ]}
                colorScheme={appearance}
                onPressAction={() => {
                  if (item.space) confirmDeleteSpace(item.space);
                }}
              >
                <View
                  accessibilityLabel={t("Space actions for {name}", { name: item.title })}
                  accessibilityRole="button"
                  style={styles.spaceActions}
                >
                  <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={20} />
                </View>
              </MenuView>
            ) : null}
          </View>
        ) : (
          <View style={styles.sectionHeadingRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                item.collapsed
                  ? t("Expand {name}", { name: item.title })
                  : t("Collapse {name}", { name: item.title })
              }
              accessibilityState={{ expanded: !item.collapsed }}
              accessibilityValue={item.collapsed ? { text: String(item.count ?? 0) } : undefined}
              onPress={() => toggleCollapsed(item.key)}
              style={({ pressed }) => [styles.sectionToggle, pressed && styles.rowPressed]}
            >
              <Text style={styles.sectionTitle}>{item.title}</Text>
              {item.collapsed ? <Text style={styles.sectionCount}>{item.count ?? 0}</Text> : null}
              <SectionChevron collapsed={item.collapsed === true} />
            </Pressable>
            {item.sectionId && Platform.OS === "android" ? (
              // A plain button, like the create control: the Android menu trigger can collapse to
              // zero width on an older binary, which would hide the only way to delete an empty section.
              <Pressable
                accessibilityLabel={t("Delete section")}
                accessibilityRole="button"
                onPress={() => {
                  if (item.sectionId) deleteSection({ id: item.sectionId, name: item.title });
                }}
                style={styles.spaceActions}
              >
                <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={20} />
              </Pressable>
            ) : item.sectionId ? (
              <MenuView
                actions={[
                  {
                    id: "delete",
                    title: t("Delete section"),
                    image: "trash",
                    attributes: { destructive: true },
                  },
                ]}
                colorScheme={appearance}
                onPressAction={() => {
                  if (item.sectionId) deleteSection({ id: item.sectionId, name: item.title });
                }}
              >
                <View
                  accessibilityLabel={t("Section actions for {name}", { name: item.title })}
                  accessibilityRole="button"
                  style={styles.spaceActions}
                >
                  <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={20} />
                </View>
              </MenuView>
            ) : null}
          </View>
        )
      ) : item.type === "group" ? (
        <GroupRow
          group={item.group}
          day={day}
          onPress={openGroup}
          onLongPress={!SWIPE_ROWS ? organizeGroup : undefined}
          onAction={SWIPE_ROWS && item.group.spaceId === me?.spaceId ? groupAction : undefined}
          sections={botSections}
          onOrganize={organizeFromMenu}
          onEditSection={editSectionFromMenu}
        />
      ) : (
        <BotRow
          bot={item.bot}
          day={day}
          onPress={openBot}
          onLongPress={!onShareSelect && !SWIPE_ROWS ? organizeBot : undefined}
          onAction={
            !onShareSelect && SWIPE_ROWS && item.bot.spaceId === me?.spaceId ? botAction : undefined
          }
          sections={botSections}
          onOrganize={organizeFromMenu}
          onEditSection={editSectionFromMenu}
        />
      ),
    [
      appearance,
      botAction,
      botSections,
      chooseInboxSpace,
      confirmDeleteSpace,
      deleteSection,
      day,
      editSectionFromMenu,
      groupAction,
      me?.spaceId,
      openBot,
      openGroup,
      onShareSelect,
      organizeBot,
      organizeFromMenu,
      organizeGroup,
      spaceBusy,
      spaceRecoveryId,
      styles,
      t,
      toggleCollapsed,
    ],
  );

  if (!ready) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <ActivityIndicator color={native.secondaryLabel} />
      </View>
    );
  }
  if (!hasSession) return <Redirect href="/sign-in" />;
  // With nothing to show, the failure takes the screen; over saved chats it stays one line.
  // Headings of empty saved Spaces are not chats, so they do not hide the failure.
  const showLoadFailure = Boolean(loadFailure) && inboxHasNoChats(listData);
  const inlineError = error ?? (showLoadFailure ? null : (loadFailure?.message ?? null));

  return (
    <View style={styles.screen}>
      {nativeHeader || onShareSelect ? null : (
        <View
          style={[
            styles.header,
            {
              paddingTop: Math.max(insets.top, 20) + 8,
              paddingLeft: 16 + columnInsets.left,
              paddingRight: 16 + columnInsets.right,
            },
          ]}
        >
          <View style={styles.circleButton}>
            <HeaderButton accessibilityLabel={t("Account")} onPress={() => router.push("/account")}>
              <Text style={styles.profileInitials}>{initials}</Text>
            </HeaderButton>
          </View>
          <View style={styles.headerActions}>
            <HeaderButton
              accessibilityLabel={t("Activity")}
              active={activityMode}
              accent
              onPress={toggleActivityMode}
            >
              <NativeSymbol
                ios={activityMode ? "bell.fill" : "bell"}
                android={activityMode ? "notifications" : "notifications-outline"}
                size={17}
                color={activityMode ? tokens.primaryForeground : tokens.foreground}
              />
            </HeaderButton>
            <HeaderButton
              testID="home-search-button"
              accessibilityLabel={t("Search")}
              onPress={() => router.push("/search")}
            >
              <NativeSymbol ios="magnifyingglass" android="search" size={17} />
            </HeaderButton>
            {Platform.OS === "android" ? (
              // A plain button: the native Android menu trigger collapses to zero width when the
              // installed app binary is older than the JS update, which hid the only way to create.
              <HeaderButton accessibilityLabel={t("Create")} onPress={openCreateChooser}>
                <NativeSymbol ios="plus" android="add" size={18} />
              </HeaderButton>
            ) : (
              <MenuView
                actions={[
                  { id: "bot", title: t("New bot"), image: "person.crop.circle.badge.plus" },
                  { id: "group", title: t("New group"), image: "person.2" },
                  { id: "space", title: t("New space"), image: "square.grid.2x2" },
                ]}
                colorScheme={appearance}
                onPressAction={({ nativeEvent }) => {
                  const action = nativeEvent.event;
                  if (action === "bot" || action === "group" || action === "space") {
                    runCreateAction(action);
                  }
                }}
              >
                <View
                  accessibilityLabel={t("Create")}
                  accessibilityRole="button"
                  style={styles.headerButton}
                >
                  <NativeSymbol ios="plus" android="add" size={18} />
                </View>
              </MenuView>
            )}
          </View>
        </View>
      )}

      <SelectedChatContext.Provider value={embedded ? selectedChatId : null}>
        <CompactRowsContext.Provider value={compactRows}>
          <View style={styles.listArea}>
            <AvatarViewportScope viewport={avatarViewport}>
              <FlatList<InboxItem>
                ref={listRef}
                {...unreadJump.listProps}
                style={{ flex: 1 }}
                // Rows scrolled out of view freeze their avatars until they come back.
                onViewableItemsChanged={onViewableItemsChanged}
                viewabilityConfig={AVATAR_VIEWABILITY}
                data={showLoadFailure ? [] : listData}
                keyExtractor={inboxItemKey}
                keyboardDismissMode="interactive"
                keyboardShouldPersistTaps="handled"
                indicatorStyle={appearance === "dark" ? "white" : "black"}
                contentContainerStyle={[
                  styles.list,
                  { paddingLeft: columnInsets.left, paddingRight: columnInsets.right },
                ]}
                contentInsetAdjustmentBehavior="automatic"
                refreshControl={
                  <RefreshControl
                    refreshing={refreshing}
                    onRefresh={() => {
                      void refreshBots();
                      void loadActivity();
                    }}
                    tintColor={native.secondaryLabel}
                    colors={[tokens.mutedForeground]}
                    progressBackgroundColor={tokens.muted}
                  />
                }
                ListHeaderComponent={
                  <>
                    {inlineError ? <Text style={styles.error}>{inlineError}</Text> : null}
                    {spaceRecoveryId ? (
                      <Pressable
                        accessibilityRole="button"
                        disabled={spaceBusy}
                        onPress={() => void chooseInboxSpace(spaceRecoveryId)}
                        style={styles.recoveryAction}
                      >
                        <Text style={styles.spaceTitle}>{t("Try again.")}</Text>
                      </Pressable>
                    ) : null}
                    {!onShareSelect &&
                    activityMode &&
                    (activity.active.length > 0 || activity.recent.length > 0) ? (
                      <ActivitySection activity={activity} bots={bots} />
                    ) : null}
                  </>
                }
                ListEmptyComponent={
                  showLoadFailure && loadFailure ? (
                    <HomeErrorState
                      kind={loadFailure.kind}
                      message={loadFailure.message}
                      loading={inboxLoading && !refreshing}
                      onRetry={() => void refreshBots()}
                      onSignIn={() => void signInAgain()}
                    />
                  ) : (
                    <Text style={styles.empty}>
                      {me && !onShareSelect ? t("Tap + to create a bot") : null}
                    </Text>
                  )
                }
                ListFooterComponent={
                  <>
                    {!onShareSelect && !showLoadFailure && inboxNeedsCreateHint(listData) ? (
                      <Text style={styles.empty}>{t("Tap + to create a bot")}</Text>
                    ) : null}
                    <ArchivedChatsRow
                      count={archivedCount}
                      onPress={() => router.push("/archived-bots")}
                    />
                  </>
                }
                renderItem={renderItem}
              />
            </AvatarViewportScope>
            {onShareSelect || refreshing || showLoadFailure || inboxHasNoChats(listData)
              ? null
              : unreadJump.overlay}
          </View>
        </CompactRowsContext.Provider>
      </SelectedChatContext.Provider>
      {organizeChat && organizeTarget ? (
        <BotOrganizeModal
          bot={organizeChat}
          sections={organizeSpace?.botSections ?? organizeTarget.sections}
          onClose={() => {
            organizeRequestId.current += 1;
            setOrganizeTarget(null);
          }}
          onUpdate={(update) => updateChat(organizeTarget.kind, organizeChat, update)}
          onCreateSection={(name) =>
            createSection(organizeTarget.kind, organizeChat.id, name, organizeTarget.spaceId)
          }
          onRenameSection={(sectionId, name) =>
            renameSection(sectionId, name, organizeTarget.spaceId)
          }
          onDeleteSection={async (sectionId) => {
            await chatRpc(organizeTarget.spaceId, "botSections/remove", { sectionId });
            await loadBots();
          }}
        />
      ) : null}
    </View>
  );
}

function ActivitySection({
  activity,
  bots,
}: {
  activity: { active: RunActivityRow[]; recent: RunActivityRow[] };
  bots: MobileBot[];
}) {
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useI18n();
  const router = useRouter();
  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const openRun = (run: RunActivityRow) => {
    if (run.groupId) {
      router.push({
        pathname: "/group-thread",
        params: { groupId: run.groupId, name: run.groupName ?? t("Group") },
      });
      return;
    }
    router.push({ pathname: "/thread", params: { botId: run.botId, name: run.botName } });
  };

  return (
    <View style={styles.activitySection}>
      {activity.active.length > 0 ? (
        <>
          <Text style={styles.sectionHeading}>{t("Now")}</Text>
          {activity.active.map((run) => (
            <ActivityRow
              key={run.runId}
              run={run}
              bot={botsById.get(run.botId)}
              onPress={() => openRun(run)}
            />
          ))}
        </>
      ) : null}
      {activity.recent.length > 0 ? (
        <>
          <Text style={[styles.sectionHeading, activity.active.length > 0 && styles.activityGap]}>
            {t("Recent")}
          </Text>
          {activity.recent.map((run) => (
            <ActivityRow
              key={run.runId}
              run={run}
              bot={botsById.get(run.botId)}
              onPress={() => openRun(run)}
            />
          ))}
        </>
      ) : null}
    </View>
  );
}

function ActivityRow({
  run,
  bot,
  onPress,
}: {
  run: RunActivityRow;
  bot?: MobileBot;
  onPress: () => void;
}) {
  const title = run.groupName ? `${run.botName} · ${run.groupName}` : run.botName;
  const status = activityStatusLabel(run.status);
  const snippet = activityPreview(run);
  const preview = snippet ? `${snippet} · ${status}` : status;
  return (
    <ConversationRow
      title={title}
      preview={preview}
      time={formatActivityRelativeTime(run.updatedAt)}
      accessibilityLabel={`${title}, ${status}`}
      onPress={onPress}
      avatar={
        <BotAvatar
          identity={run.botId}
          color={bot?.color ?? FALLBACK_COLOR}
          status={run.status}
          motion="lazy"
        />
      }
    />
  );
}

const INBOX_ROW = { padding: 16, gap: 12, avatarSize: 62 };
const COMPACT_INBOX_ROW = { padding: 12, gap: 10 };

function ConversationRow({
  chatId,
  title,
  preview,
  time,
  avatar,
  tag,
  unread,
  onPress,
  onLongPress,
  actions = [],
  onAction,
  accessibilityLabel,
  accessibilityHint,
}: {
  chatId?: string;
  title: string;
  preview: string;
  time: string;
  avatar: ReactNode;
  tag?: string | null;
  unread?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  actions?: InboxRowAction[];
  onAction?: (action: InboxRowAction) => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
}) {
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useI18n();
  const compact = useContext(CompactRowsContext);
  const tagBelow = stacksAtTextScale(useWindowDimensions().fontScale);
  const openChatId = useContext(SelectedChatContext);
  const selected = chatId !== undefined && openChatId === chatId;
  const rowActions = actions.map((action) => ({
    name: action,
    label: t(INBOX_ROW_ACTIONS[action].label),
  }));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      // Screen readers access swipe actions through the row.
      accessibilityActions={rowActions.length > 0 ? rowActions : undefined}
      onAccessibilityAction={(event) => {
        const name = event.nativeEvent.actionName;
        const action = actions.find((item) => item === name);
        if (action) onAction?.(action);
      }}
      android_ripple={androidRipple()}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.row,
        compact ? styles.compactRow : null,
        selected ? styles.rowSelected : null,
        selected && Platform.OS === "android" && { overflow: "hidden" },
        pressed && Platform.OS !== "android" && styles.rowPressed,
      ]}
    >
      {avatar}
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <View style={[styles.titleRow, tagBelow && styles.titleRowWrapped]}>
            <Text style={styles.name} numberOfLines={1} ellipsizeMode="tail">
              {title}
            </Text>
            {tag && !compact ? (
              <View style={styles.tag}>
                <Text style={styles.tagLabel} numberOfLines={1}>
                  {tag}
                </Text>
              </View>
            ) : null}
          </View>
          <View style={styles.rowMeta}>
            {time ? <Text style={styles.time}>{time}</Text> : null}
            {unread ? <View accessibilityElementsHidden style={styles.unreadDot} /> : null}
          </View>
        </View>
        <Text style={[styles.preview, unread && styles.unreadPreview]} numberOfLines={1}>
          {preview}
        </Text>
      </View>
    </Pressable>
  );
}

function HeaderButton({
  testID,
  children,
  onPress,
  accessibilityLabel,
  active = false,
  accent = false,
}: {
  children: ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
  testID?: string;
  active?: boolean;
  accent?: boolean;
}) {
  const styles = useThemedStyles(createHomeStyles);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.headerButton,
        accent && active
          ? styles.headerButtonAccent
          : (active || pressed) && styles.headerButtonActive,
      ]}
    >
      {children}
    </Pressable>
  );
}

/** The way back to archived chats, at the very end of the list in the section heading style. */
function ArchivedChatsRow({ count, onPress }: { count: number; onPress: () => void }) {
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useI18n();
  if (count < 1) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t("Archived")}, ${count}`}
      onPress={onPress}
      style={({ pressed }) => [
        // Laid out like a section header, so it lines up with them whatever sits above it.
        styles.sectionToggle,
        styles.archivedRow,
        pressed && styles.rowPressed,
      ]}
    >
      <Text style={styles.sectionTitle}>{t("Archived")}</Text>
      <Text style={styles.sectionCount}>{count}</Text>
      <NativeSymbol
        ios="chevron.right"
        android="chevron-forward"
        size={12}
        color={native.tertiaryLabel}
      />
    </Pressable>
  );
}

/** Points right while a section is collapsed and turns down as it opens. */
function SectionChevron({ collapsed }: { collapsed: boolean }) {
  const rotation = useSharedValue(collapsed ? 0 : 90);
  useEffect(() => {
    rotation.value = withTiming(collapsed ? 0 : 90, {
      duration: 220,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    });
  }, [collapsed, rotation]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
  return (
    <Animated.View style={style}>
      <NativeSymbol
        ios="chevron.right"
        android="chevron-forward"
        size={12}
        color={native.tertiaryLabel}
      />
    </Animated.View>
  );
}

/** Android pinned chats open with a tap and organize with a long press. */
const PinnedTiles = memo(function PinnedTiles({
  chats,
  onOpenBot,
  onOpenGroup,
  onLongPressBot,
  onLongPressGroup,
  onBotAction,
  onGroupAction,
}: {
  chats: PinnedChat[];
  onOpenBot: (bot: MobileBot | SpaceBot) => void;
  onOpenGroup: (group: MobileGroup | SpaceGroup) => void;
  onLongPressBot: (bot: MobileBot | SpaceBot) => void;
  onLongPressGroup: (group: MobileGroup | SpaceGroup) => void;
  onBotAction: (action: InboxRowAction, bot: MobileBot | SpaceBot) => void;
  onGroupAction: (action: InboxRowAction, group: MobileGroup | SpaceGroup) => void;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createHomeStyles);
  const selectedId = useContext(SelectedChatContext);
  // Three tiles share the row, so a narrow pane shrinks the avatars instead of overlapping them.
  const [rowWidth, setRowWidth] = useState(0);
  const avatarSize = rowWidth > 0 ? Math.min(84, Math.floor((rowWidth - 16) / 3 - 8)) : 84;
  return (
    <View
      style={styles.pinnedTiles}
      onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}
    >
      {chats.map((chat) => {
        const id = chat.kind === "bot" ? chat.bot.id : chat.group.id;
        const name = chat.kind === "bot" ? chat.bot.name : chat.group.name;
        const unread = chat.kind === "bot" ? chat.bot.unread : chat.group.unread;
        const actions = inboxRowActionList(chat.kind === "bot" ? chat.bot : chat.group);
        const runAction = (action: InboxRowAction) =>
          chat.kind === "bot" ? onBotAction(action, chat.bot) : onGroupAction(action, chat.group);
        const organize = () =>
          chat.kind === "bot" ? onLongPressBot(chat.bot) : onLongPressGroup(chat.group);
        return (
          <Pressable
            key={`${chat.kind}-${id}`}
            accessibilityRole="button"
            accessibilityLabel={name}
            accessibilityState={{ selected: selectedId === id }}
            accessibilityActions={actions.map((action) => ({
              name: action,
              label: t(INBOX_ROW_ACTIONS[action].label),
            }))}
            onAccessibilityAction={(event) => {
              const action = actions.find((item) => item === event.nativeEvent.actionName);
              if (action) runAction(action);
            }}
            onPress={() => (chat.kind === "bot" ? onOpenBot(chat.bot) : onOpenGroup(chat.group))}
            onLongPress={organize}
            style={({ pressed }) => [
              styles.pinnedTile,
              selectedId === id ? { backgroundColor: native.fillPressed } : null,
              pressed && styles.rowPressed,
            ]}
          >
            {chat.kind === "bot" ? (
              <BotAvatar
                color={chat.bot.color || FALLBACK_COLOR}
                identity={chat.bot.id}
                size={avatarSize}
                status={chat.bot.status}
                muted={chat.bot.notifyOnFinish === false}
                motion="lazy"
              />
            ) : (
              <GroupAvatar members={chat.group.members} size={avatarSize} />
            )}
            <Text style={[styles.pinnedName, unread && styles.pinnedUnread]} numberOfLines={1}>
              {name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
});
/** What the iOS row menu needs to organize a chat in place. */
type RowMenuProps = {
  sections: readonly MobileBotSection[];
  onOrganize: (
    kind: InboxChatKind,
    chat: MobileBot | MobileGroup | SpaceBot | SpaceGroup,
    update: BotOrganizationUpdate,
  ) => void;
  onEditSection: (
    kind: InboxChatKind,
    chat: MobileBot | MobileGroup | SpaceBot | SpaceGroup,
    mode: "create" | "rename",
  ) => void;
};

const BotRow = memo(function BotRow({
  bot,
  day,
  onPress,
  onLongPress,
  onAction,
  sections,
  onOrganize,
  onEditSection,
}: {
  bot: MobileBot | SpaceBot;
  day: number;
  onPress: (bot: MobileBot | SpaceBot) => void;
  onLongPress?: (bot: MobileBot | SpaceBot) => void;
  onAction?: (action: InboxRowAction, bot: MobileBot | SpaceBot) => void;
} & RowMenuProps) {
  const { t } = useI18n();
  const preview = previewSnippet(bot.preview, 40) || bot.title || t("No messages yet");
  const time = bot.updatedAt ? formatThreadTime(bot.updatedAt, new Date(day)) : "";
  const tag = botTag(bot.title, bot.name);
  const working = isRunWorking(bot.status);
  // Spelled out because an explicit label replaces the one built from the row's children.
  const label = [
    bot.name,
    tag,
    working ? t("Working…") : null,
    bot.notifyOnFinish === false ? t("notifications silenced") : null,
    bot.unread ? t("unread") : null,
    time,
    preview,
  ]
    .filter(Boolean)
    .join(", ");
  const runAction = (action: InboxRowAction) => onAction?.(action, bot);
  const row = (
    <ConversationRow
      chatId={bot.id}
      title={bot.name}
      preview={preview}
      time={time}
      tag={tag}
      unread={bot.unread}
      accessibilityLabel={label}
      accessibilityHint={
        onLongPress || onAction ? t("Long press to pin, move, or silence notifications") : undefined
      }
      onPress={() => onPress(bot)}
      onLongPress={onLongPress ? () => onLongPress(bot) : undefined}
      actions={onAction ? inboxRowActionList(bot) : undefined}
      onAction={runAction}
      avatar={
        <AvatarRow id={bot.id}>
          <BotAvatar
            color={bot.color || FALLBACK_COLOR}
            identity={bot.id}
            size={INBOX_ROW.avatarSize}
            status={bot.status}
            muted={bot.notifyOnFinish === false}
            motion="lazy"
          />
        </AvatarRow>
      }
    />
  );
  return onAction ? (
    <InboxSwipeRow
      rowKey={`bot:${bot.id}`}
      unread={bot.unread}
      pinned={bot.pinned}
      notifyOnFinish={bot.notifyOnFinish}
      sectionId={bot.sectionId}
      sections={sections}
      preview={{
        title: bot.name,
        message: bot.preview,
        avatar: <BotAvatar color={bot.color || FALLBACK_COLOR} identity={bot.id} size={32} />,
      }}
      onAction={runAction}
      onOrganize={(update) => onOrganize("bot", bot, update)}
      onEditSection={(mode) => onEditSection("bot", bot, mode)}
    >
      {row}
    </InboxSwipeRow>
  ) : (
    row
  );
});

const GroupRow = memo(function GroupRow({
  group,
  day,
  onPress,
  onLongPress,
  onAction,
  sections,
  onOrganize,
  onEditSection,
}: {
  group: MobileGroup | SpaceGroup;
  day: number;
  onPress: (group: MobileGroup | SpaceGroup) => void;
  onLongPress?: (group: MobileGroup | SpaceGroup) => void;
  onAction?: (action: InboxRowAction, group: MobileGroup | SpaceGroup) => void;
} & RowMenuProps) {
  const { t } = useI18n();
  const preview =
    previewSnippet(group.preview, 40) || group.members.map((member) => member.name).join(", ");
  const time = group.updatedAt ? formatThreadTime(group.updatedAt, new Date(day)) : "";
  const runAction = (action: InboxRowAction) => onAction?.(action, group);
  const row = (
    <ConversationRow
      chatId={group.id}
      title={group.name}
      preview={preview}
      time={time}
      unread={group.unread}
      accessibilityLabel={[group.name, group.unread ? t("unread") : null, time, preview]
        .filter(Boolean)
        .join(", ")}
      accessibilityHint={
        onLongPress || onAction ? t("Long press to pin or move to a section") : undefined
      }
      onPress={() => onPress(group)}
      onLongPress={onLongPress ? () => onLongPress(group) : undefined}
      actions={onAction ? inboxRowActionList(group) : undefined}
      onAction={runAction}
      avatar={<GroupAvatar members={group.members} size={INBOX_ROW.avatarSize} />}
    />
  );
  return onAction ? (
    <InboxSwipeRow
      rowKey={`group:${group.id}`}
      unread={group.unread}
      pinned={group.pinned}
      sectionId={group.sectionId}
      sections={sections}
      preview={{
        title: group.name,
        message: group.preview,
        avatar: <GroupAvatar members={group.members} size={32} />,
      }}
      onAction={runAction}
      onOrganize={(update) => onOrganize("group", group, update)}
      onEditSection={(mode) => onEditSection("group", group, mode)}
    >
      {row}
    </InboxSwipeRow>
  ) : (
    row
  );
});

function createHomeStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: native.page,
    },
    centered: {
      alignItems: "center",
      justifyContent: "center",
    },
    emptyPane: {
      color: native.secondaryLabel,
      ...typeScale.secondary,
      textAlign: "center",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 10,
    },
    headerActions: {
      flexDirection: "row",
      alignItems: "center",
      padding: 2,
      borderRadius: 22,
      backgroundColor: native.fillPressed,
    },
    circleButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: native.fillPressed,
    },
    headerButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    headerButtonActive: {
      backgroundColor: native.fill,
    },
    headerButtonAccent: {
      backgroundColor: tokens.primary,
    },
    profileInitials: {
      color: native.label,
      fontSize: 15,
      fontWeight: "600",
    },
    error: {
      color: native.secondaryLabel,
      paddingHorizontal: 20,
      paddingBottom: 8,
    },
    listArea: {
      flex: 1,
    },
    list: {
      flexGrow: 1,
      paddingBottom: 32,
    },
    empty: {
      color: native.secondaryLabel,
      fontSize: 16,
      paddingHorizontal: 20,
      paddingTop: 28,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: INBOX_ROW.padding,
      paddingVertical: 14,
      gap: INBOX_ROW.gap,
    },
    rowSelected: {
      marginHorizontal: 12,
      paddingHorizontal: 4,
      borderRadius: 12,
      backgroundColor: native.fillPressed,
    },
    pinnedTiles: {
      flexDirection: "row",
      flexWrap: "wrap",
      paddingHorizontal: 8,
      paddingTop: 4,
      paddingBottom: 12,
    },
    pinnedTile: {
      width: "33.33%",
      alignItems: "center",
      paddingVertical: 8,
      paddingHorizontal: 4,
      borderRadius: 16,
      gap: 4,
    },
    pinnedName: {
      color: native.secondaryLabel,
      fontSize: 13,
      fontWeight: "500",
      textAlign: "center",
      writingDirection: "auto",
    },
    pinnedUnread: {
      color: native.label,
      fontWeight: "700",
    },
    compactRow: {
      paddingHorizontal: COMPACT_INBOX_ROW.padding,
      gap: COMPACT_INBOX_ROW.gap,
    },
    rowPressed: {
      opacity: 0.55,
    },
    rowBody: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    rowTop: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
    },
    titleRow: {
      flex: 1,
      minWidth: 0,
      overflow: "hidden",
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    // At the largest text sizes a tag that doesn't fit beside the name moves under it.
    titleRowWrapped: {
      flexWrap: "wrap",
    },
    rowMeta: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
    },
    name: {
      flexShrink: 0,
      maxWidth: "100%",
      color: native.label,
      ...typeScale.cardTitle,
      writingDirection: "auto",
    },
    tag: {
      flexShrink: 1,
      minWidth: 0,
      overflow: "hidden",
      borderRadius: 999,
      backgroundColor: native.quietFill,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    tagLabel: {
      color: native.secondaryLabel,
      fontSize: typeScale.caption.fontSize,
      fontWeight: fontWeight.medium,
      writingDirection: "auto",
    },
    time: {
      color: native.tertiaryLabel,
      ...typeScale.caption,
    },
    preview: {
      color: native.secondaryLabel,
      ...typeScale.secondary,
      writingDirection: "auto",
    },
    unreadPreview: {
      color: native.label,
      fontWeight: "600",
    },
    unreadDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: tokens.unread,
    },
    spaceHeading: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingTop: 8,
    },
    spaceSelect: {
      flex: 1,
      minHeight: 44,
      justifyContent: "center",
    },
    spaceTitle: {
      color: native.label,
      fontSize: 14,
      fontWeight: "600",
      writingDirection: "auto",
    },
    spaceActions: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    recoveryAction: {
      minHeight: 44,
      paddingHorizontal: 20,
      justifyContent: "center",
    },
    sectionHeadingRow: { flexDirection: "row", alignItems: "center", paddingRight: 16 },
    sectionToggle: {
      flex: 1,
      alignSelf: "stretch",
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
    },
    archivedRow: { flex: 0, width: "100%" },
    sectionTitle: {
      flexShrink: 1,
      color: native.secondaryLabel,
      ...typeScale.secondary,
    },
    sectionCount: {
      color: native.tertiaryLabel,
      ...typeScale.caption,
      fontVariant: ["tabular-nums"],
    },
    sectionHeading: {
      color: native.secondaryLabel,
      ...typeScale.secondary,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
    },
    activitySection: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: native.fillPressed,
      marginBottom: 4,
      paddingBottom: 4,
    },
    activityGap: {
      paddingTop: 16,
    },
    groupAvatar: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: native.fill,
      alignItems: "center",
      justifyContent: "center",
    },
    groupAvatarLabel: {
      color: native.secondaryLabel,
      fontSize: 16,
      fontWeight: "600",
    },
  });
}
