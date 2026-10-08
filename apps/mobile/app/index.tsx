import { MenuView } from "@expo/ui/community/menu";
import type { RunActivityRow, SearchHit, SpaceBot, SpaceGroup } from "@rakazo/contracts";
import { normalizeCreateBotProfile } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { botColors } from "@rakazo/ui-tokens";
import { Redirect, useFocusEffect, useNavigation, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar } from "../components/bot-avatar";
import { BotOrganizeModal } from "../components/bot-organize-modal";
import { GroupAvatar } from "../components/group-avatar";
import { NativeSymbol } from "../components/native-symbol";
import { WorkingIndicator } from "../components/WorkingIndicator";
import {
  activityStatusLabel,
  fetchSpaceActivity,
  formatActivityRelativeTime,
} from "../lib/activity";
import { loadActivityMode, saveActivityMode } from "../lib/activity-mode";
import type {
  MobileBot,
  MobileBotSection,
  MobileGroup,
  MobileMe,
  MobileSpace,
  MobileSpaceNavigation,
} from "../lib/api";
import {
  currentApiBase,
  loadSessionToken,
  rpc,
  selectedSpaceId,
  selectInitialSpace,
  selectSpace,
} from "../lib/api";
import { mobileTokens, resolveMobileAppearance } from "../lib/appearance";
import { mobileBotAvatarPresentation } from "../lib/bot-avatar";
import { allowFocusPrompt, scheduleFocusPrompt } from "../lib/focus-prompt";
import { t, useI18n } from "../lib/i18n";
import { botTag, filterBots, formatThreadTime, userInitials } from "../lib/inbox";
import type { InboxSpace, InboxSpaceItem } from "../lib/inbox-spaces";
import {
  canDeleteInboxSpace,
  inboxNeedsCreateHint,
  removeInboxSpace,
  retryInboxSpaceFallback,
  selectInboxSpace,
  spaceInboxItems,
} from "../lib/inbox-spaces";
import { dismissThreadNotifications, resumeLiveNotifications } from "../lib/live-notifications";
import { native, useThemedStyles } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import { previewSnippet } from "../lib/preview";
import { registerPushToken } from "../lib/push";
import { querySpaceSearch } from "../lib/search";
import { mobileSearchDestination } from "../lib/search-destination";
import { dedupeSearchHits, searchHitListKey, searchHitRowPreview } from "../lib/search-list";
import { errorText } from "../lib/user-error";

const FALLBACK_COLOR = botColors[3];

type InboxItem = InboxSpaceItem | { type: "search"; hit: SearchHit };

async function openMobileSpace(spaceId: string | undefined, open: () => void) {
  if (spaceId && !(await selectSpace(spaceId))) {
    Alert.alert(t("Could not switch spaces"), t("Try again."));
    return;
  }
  open();
}

export default function Home() {
  const tokens = mobileTokens();
  const appearance = resolveMobileAppearance();
  const styles = useThemedStyles(createHomeStyles);
  const { t, locale } = useI18n();
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [groups, setGroups] = useState<MobileGroup[]>([]);
  const [botSections, setBotSections] = useState<MobileBotSection[]>([]);
  const [spaces, setSpaces] = useState<MobileSpace[]>([]);
  const [me, setMe] = useState<MobileMe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [organizeTarget, setOrganizeTarget] = useState<{
    kind: "bot" | "group";
    id: string;
  } | null>(null);
  const [activityMode, setActivityMode] = useState(false);
  const [activity, setActivity] = useState<{ active: RunActivityRow[]; recent: RunActivityRow[] }>({
    active: [],
    recent: [],
  });
  const activityRequestId = useRef(0);
  const inboxRequestId = useRef(0);
  const creatingBotRef = useRef(false);
  const spaceActionRef = useRef<{ busy: boolean; recoveryId: string | null }>({
    busy: false,
    recoveryId: null,
  });
  const [spaceBusy, setSpaceBusy] = useState(false);
  const [spaceRecoveryId, setSpaceRecoveryId] = useState<string | null>(null);
  const [collapsedRosterParents, setCollapsedRosterParents] = useState(() => new Set<string>());
  const toggleRosterParent = useCallback((botId: string) => {
    setCollapsedRosterParents((previous) => {
      const next = new Set(previous);
      if (next.has(botId)) next.delete(botId);
      else next.add(botId);
      return next;
    });
  }, []);

  useEffect(() => {
    void loadActivityMode().then(setActivityMode);
  }, []);

  const toggleActivityMode = useCallback(() => {
    setActivityMode((on) => {
      const next = !on;
      void saveActivityMode(next);
      return next;
    });
  }, []);

  const loadBots = useCallback(async () => {
    if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
    const requestId = ++inboxRequestId.current;
    setError(null);
    try {
      const [navigation, nextMe] = await Promise.all([
        rpc<MobileSpaceNavigation>("spaces/list"),
        rpc<MobileMe>("me"),
      ]);
      if (requestId !== inboxRequestId.current) return;
      if (!(await selectInitialSpace(nextMe.spaceId))) {
        throw new Error(t("Could not save the default space"));
      }
      if (requestId !== inboxRequestId.current) return;
      setBots(navigation.current.bots);
      setBotSections(navigation.current.botSections);
      setGroups(navigation.current.groups);
      setSpaces(navigation.spaces);
      setMe(nextMe);
    } catch (err) {
      if (requestId !== inboxRequestId.current) return;
      setError(errorText(err, t("Could not load bots")));
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
    void loadSessionToken().then((token) => {
      setHasSession(Boolean(token));
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!hasSession) return;
    void registerPushToken().catch(() => undefined);
  }, [hasSession]);

  useFocusEffect(
    useCallback(() => {
      if (!hasSession) return;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = async () => {
        if (AppState.currentState === "active") await loadBots();
        if (!cancelled) timer = setTimeout(() => void tick(), 5_000);
      };
      void tick();
      return () => {
        cancelled = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    }, [hasSession, loadBots]),
  );

  const loadActivity = useCallback(async () => {
    if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
    if (!hasSession || !activityMode || searching || query.trim()) {
      activityRequestId.current += 1;
      setActivity({ active: [], recent: [] });
      return;
    }
    const requestId = ++activityRequestId.current;
    try {
      const next = await fetchSpaceActivity();
      if (requestId !== activityRequestId.current) return;
      setActivity(next);
    } catch {
      // Keep the last good snapshot on transient RPC failures; only drop stale responses.
      if (requestId !== activityRequestId.current) return;
    }
  }, [activityMode, hasSession, query, searching]);

  useFocusEffect(
    useCallback(() => {
      if (!hasSession || !activityMode || searching || query.trim()) return;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const tick = async () => {
        await loadActivity();
        if (!cancelled) {
          timer = setTimeout(() => void tick(), 15_000);
        }
      };

      void tick();
      return () => {
        cancelled = true;
        activityRequestId.current += 1;
        if (timer !== undefined) clearTimeout(timer);
      };
    }, [activityMode, hasSession, loadActivity, query, searching]),
  );

  useEffect(() => {
    const trimmed = query.trim();
    if (!searching || !trimmed) {
      setSearchHits([]);
      setSearchLoading(false);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      setSearchLoading(true);
      void querySpaceSearch(trimmed)
        .then((hits) => {
          if (!abort.signal.aborted) setSearchHits(hits);
        })
        .catch(() => {
          if (!abort.signal.aborted) setSearchHits([]);
        })
        .finally(() => {
          if (!abort.signal.aborted) setSearchLoading(false);
        });
    }, 200);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [query, searching]);

  const visible = useMemo(() => filterBots(bots, query), [bots, query]);
  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groups;
    return groups.filter((group) =>
      `${group.name} ${group.preview}`.toLowerCase().includes(needle),
    );
  }, [groups, query]);
  const listData = useMemo((): InboxItem[] => {
    if (query.trim() && searching) {
      return dedupeSearchHits(searchHits).map((hit) => ({ type: "search" as const, hit }));
    }
    const sidebarSpaces =
      spaces.length > 0
        ? spaces.map((space) =>
            space.id === me?.spaceId
              ? { ...space, bots: visible, groups: visibleGroups, botSections }
              : {
                  ...space,
                  bots: filterBots(space.bots, query),
                  groups: space.groups.filter((group) =>
                    `${group.name} ${group.preview}`
                      .toLowerCase()
                      .includes(query.trim().toLowerCase()),
                  ),
                },
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
          : [];
    return spaceInboxItems(sidebarSpaces, collapsedRosterParents);
  }, [
    botSections,
    collapsedRosterParents,
    locale,
    me,
    spaces,
    query,
    searching,
    searchHits,
    visible,
    visibleGroups,
  ]);
  const initials = userInitials(me?.name ?? "");
  const organizeChat = organizeTarget
    ? organizeTarget.kind === "bot"
      ? bots.find((bot) => bot.id === organizeTarget.id)
      : groups.find((group) => group.id === organizeTarget.id)
    : null;
  const insets = useSafeAreaInsets();
  // Liquid Glass uses the native bar: glass bar items, a native menu, and bottom search.
  const nativeHeader = iosAtLeast(26);
  const navigation = useNavigation();
  const router = useRouter();

  async function chooseInboxSpace(spaceId: string) {
    if (spaceActionRef.current.busy) return;
    spaceActionRef.current.busy = true;
    setSpaceBusy(true);
    inboxRequestId.current += 1;
    activityRequestId.current += 1;
    setActivity({ active: [], recent: [] });
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
  }

  async function deleteInboxSpace(space: InboxSpace) {
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
  }

  function confirmDeleteSpace(space: InboxSpace) {
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
  }

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
      router.push({ pathname: "/thread", params: { botId: bot.id, name: bot.name } });
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
  }, [refreshBots, router, t]);

  const runCreateAction = useCallback(
    (action: "bot" | "group" | "space") => {
      if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
      if (action === "bot") void createQuickBot();
      else if (action === "group") router.push("/new-group");
      else router.push("/new-space");
    },
    [createQuickBot, router],
  );

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
          label: initials,
          labelStyle: { fontSize: 15, fontWeight: "600" },
          accessibilityLabel: t("Account"),
          onPress: () => router.push("/account"),
        },
      ],
      unstable_headerRightItems: () => [
        {
          type: "button" as const,
          accessibilityLabel: t("Activity"),
          icon: { type: "sfSymbol" as const, name: activityMode ? "bell.fill" : "bell" },
          selected: activityMode,
          onPress: toggleActivityMode,
        },
        {
          type: "button" as const,
          accessibilityLabel: t("Artifacts"),
          icon: { type: "sfSymbol" as const, name: "square.stack.3d.up" },
          onPress: () => router.push("/artifacts"),
        },
        {
          type: "menu" as const,
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
      headerSearchBarOptions: {
        placeholder: t("Search"),
        hideWhenScrolling: false,
        autoCapitalize: "none",
        onFocus: () => setSearching(true),
        onChangeText: (event: { nativeEvent: { text: string } }) =>
          setQuery(event.nativeEvent.text),
        onCancelButtonPress: () => {
          setSearching(false);
          setQuery("");
        },
      },
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

  if (!ready) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <ActivityIndicator color={native.secondaryLabel} />
      </View>
    );
  }
  if (!hasSession) return <Redirect href="/sign-in" />;

  return (
    <View style={styles.screen}>
      {nativeHeader ? null : (
        <View style={[styles.header, { paddingTop: Math.max(insets.top, 20) + 8 }]}>
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
              accessibilityLabel={t("Search")}
              active={searching}
              onPress={() =>
                setSearching((open) => {
                  if (open) setQuery("");
                  return !open;
                })
              }
            >
              <NativeSymbol ios="magnifyingglass" android="search" size={17} />
            </HeaderButton>
            <HeaderButton
              accessibilityLabel={t("Artifacts")}
              onPress={() => router.push("/artifacts")}
            >
              <NativeSymbol ios="square.stack.3d.up" android="layers-outline" size={17} />
            </HeaderButton>
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
          </View>
        </View>
      )}

      <FlatList<InboxItem>
        style={{ flex: 1 }}
        data={listData}
        keyExtractor={(item) => {
          if (item.type === "heading") return `heading-${item.key}`;
          if (item.type === "bot") return item.bot.id;
          if (item.type === "group") return `group-${item.group.id}`;
          return searchHitListKey(item.hit);
        }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        indicatorStyle={appearance === "dark" ? "white" : "black"}
        contentContainerStyle={[
          styles.list,
          // iOS moves the active search bar to the bottom and removes the navigation inset.
          nativeHeader && searching ? { paddingTop: insets.top + 12 } : undefined,
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
            {searching && !nativeHeader ? (
              <TextInput
                autoFocus
                value={query}
                onChangeText={setQuery}
                placeholder={t("Search")}
                placeholderTextColor={tokens.mutedForeground}
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="search"
                keyboardAppearance={appearance}
                clearButtonMode="while-editing"
                style={styles.searchField}
              />
            ) : null}

            {error ? <Text style={styles.error}>{error}</Text> : null}
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
            {activityMode &&
            !searching &&
            !query.trim() &&
            (activity.active.length > 0 || activity.recent.length > 0) ? (
              <ActivitySection activity={activity} bots={bots} />
            ) : null}
          </>
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            {query.trim() && searching
              ? searchLoading
                ? t("Searching…")
                : t("No results")
              : query.trim()
                ? t("No matching bots")
                : searching
                  ? t("Search conversations, files, and routines")
                  : t("Tap + to create a bot")}
          </Text>
        }
        ListFooterComponent={
          inboxNeedsCreateHint(listData) ? (
            <Text style={styles.empty}>{t("Tap + to create a bot")}</Text>
          ) : null
        }
        renderItem={({ item }) =>
          item.type === "search" ? (
            <SearchRow
              hit={item.hit}
              onPress={() => {
                setQuery("");
                setSearchHits([]);
                // A thread that opens while the search keyboard is still up or closing sizes
                // itself against that keyboard and can leave its composer off screen.
                void KeyboardController.dismiss().then(() =>
                  router.push(mobileSearchDestination(item.hit)),
                );
              }}
            />
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
                {canDeleteInboxSpace(item.space) ? (
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
              <Text style={styles.sectionHeading}>{item.title}</Text>
            )
          ) : item.type === "group" ? (
            <GroupRow
              group={item.group}
              onPress={() => {
                if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
                void openMobileSpace(item.group.spaceId, () =>
                  router.push({
                    pathname: "/group-thread",
                    params: { groupId: item.group.id, name: item.group.name },
                  }),
                );
              }}
              onLongPress={
                item.group.spaceId === me?.spaceId
                  ? () => setOrganizeTarget({ kind: "group", id: item.group.id })
                  : undefined
              }
            />
          ) : (
            <BotRow
              bot={item.bot}
              depth={item.depth}
              hasChildren={item.hasChildren}
              collapsed={collapsedRosterParents.has(item.bot.id)}
              onToggleChildren={() => toggleRosterParent(item.bot.id)}
              onPress={() => {
                if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
                void openMobileSpace(item.bot.spaceId, () =>
                  router.push({
                    pathname: "/thread",
                    params: { botId: item.bot.id, name: item.bot.name },
                  }),
                );
              }}
              onLongPress={
                item.bot.spaceId === me?.spaceId
                  ? () => setOrganizeTarget({ kind: "bot", id: item.bot.id })
                  : undefined
              }
            />
          )
        }
      />
      {organizeChat && organizeTarget ? (
        <BotOrganizeModal
          bot={organizeChat}
          sections={botSections}
          onClose={() => setOrganizeTarget(null)}
          onUpdate={async (update) => {
            await rpc(`${organizeTarget.kind}s/update`, {
              [`${organizeTarget.kind}Id`]: organizeChat.id,
              ...update,
            });
            if (organizeTarget.kind === "bot" && update.notifyOnFinish !== undefined) {
              await resumeLiveNotifications(
                currentApiBase(),
                await loadSessionToken(),
                selectedSpaceId() ?? "",
              ).catch(() => undefined);
              if (!update.notifyOnFinish && "threadId" in organizeChat) {
                await dismissThreadNotifications({ threadId: organizeChat.threadId }).catch(
                  () => undefined,
                );
              }
            }
            await loadBots();
          }}
          onCreateSection={async (name) => {
            await rpc("botSections/create", {
              [`${organizeTarget.kind}Id`]: organizeChat.id,
              name,
            });
            await loadBots();
          }}
          onRenameSection={async (sectionId, name) => {
            await rpc("botSections/update", { sectionId, name });
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
  const preview = run.promptSnippet ? `${run.promptSnippet} · ${status}` : status;
  return (
    <ConversationRow
      title={title}
      preview={preview}
      time={formatActivityRelativeTime(run.updatedAt)}
      accessibilityLabel={`${title}, ${status}`}
      onPress={onPress}
      avatar={
        <BotAvatar identity={run.botId} color={bot?.color ?? FALLBACK_COLOR} status={run.status} />
      }
    />
  );
}

function ConversationRow({
  title,
  preview,
  time,
  avatar,
  indicator,
  tag,
  unread,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleChildren,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityHint,
}: {
  title: string;
  preview: string;
  time: string;
  avatar: ReactNode;
  indicator?: ReactNode;
  tag?: string | null;
  unread?: boolean;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleChildren?: () => void;
  onPress: () => void;
  onLongPress?: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
}) {
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useI18n();
  const toggleLabel = collapsed
    ? t("Expand {name}", { name: title })
    : t("Collapse {name}", { name: title });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      // Screen readers treat the row as one element, so the chevron is offered as a row action.
      accessibilityState={hasChildren ? { expanded: !collapsed } : undefined}
      accessibilityActions={
        hasChildren ? [{ name: "toggleChildren", label: toggleLabel }] : undefined
      }
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "toggleChildren") onToggleChildren?.();
      }}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.row,
        depth > 0 ? { paddingInlineStart: 16 + depth * 16 } : null,
        pressed && styles.rowPressed,
      ]}
    >
      {hasChildren ? (
        <Pressable
          accessible={false}
          importantForAccessibility="no"
          hitSlop={8}
          onPress={onToggleChildren}
          style={styles.treeToggle}
        >
          <NativeSymbol
            ios={collapsed ? "chevron.right" : "chevron.down"}
            android={collapsed ? "chevron-forward" : "chevron-down"}
            size={14}
          />
        </Pressable>
      ) : null}
      {avatar}
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <View style={styles.titleRow}>
            <Text style={styles.name} numberOfLines={1} ellipsizeMode="tail">
              {title}
            </Text>
            {tag ? (
              <View style={styles.tag}>
                <Text style={styles.tagLabel} numberOfLines={1}>
                  {tag}
                </Text>
              </View>
            ) : null}
          </View>
          <View style={styles.rowMeta}>
            {indicator}
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
  children,
  onPress,
  accessibilityLabel,
  active = false,
  accent = false,
}: {
  children: ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
  active?: boolean;
  accent?: boolean;
}) {
  const styles = useThemedStyles(createHomeStyles);
  return (
    <Pressable
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

function SearchRow({ hit, onPress }: { hit: SearchHit; onPress: () => void }) {
  const styles = useThemedStyles(createHomeStyles);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.name} numberOfLines={1}>
            {hit.title}
          </Text>
          <Text style={styles.time}>{hit.kind}</Text>
        </View>
        <Text style={styles.preview} numberOfLines={2}>
          {searchHitRowPreview(hit)}
        </Text>
      </View>
    </Pressable>
  );
}

function BotRow({
  bot,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleChildren,
  onPress,
  onLongPress,
}: {
  bot: MobileBot | SpaceBot;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleChildren?: () => void;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const { t } = useI18n();
  const preview = previewSnippet(bot.preview, 40) || bot.title || t("No messages yet");
  const time = bot.updatedAt ? formatThreadTime(bot.updatedAt) : "";
  const tag = botTag(bot.title, bot.name);
  const working = ACTIVE_RUN_STATUSES.some((status) => status === bot.status);
  // Only flat avatars carry a usable color; image avatars fall back to the muted dot.
  const presentation = mobileBotAvatarPresentation(bot.color || FALLBACK_COLOR);
  const tint =
    presentation.kind === "shape" || presentation.kind === "color" ? presentation.color : undefined;
  // Spelled out because an explicit label replaces the one built from the row's children.
  const label = [
    bot.name,
    tag,
    working ? t("Working…") : null,
    bot.notifyOnFinish ? null : t("notifications silenced"),
    bot.unread ? t("unread") : null,
    time,
    preview,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <ConversationRow
      title={bot.name}
      preview={preview}
      time={time}
      tag={tag}
      unread={bot.unread}
      depth={depth}
      hasChildren={hasChildren}
      collapsed={collapsed}
      onToggleChildren={onToggleChildren}
      accessibilityLabel={label}
      accessibilityHint={
        onLongPress ? t("Long press to pin, move, or silence notifications") : undefined
      }
      onPress={onPress}
      onLongPress={onLongPress}
      indicator={working ? <WorkingIndicator compact tint={tint} /> : null}
      avatar={
        <BotAvatar
          color={bot.color || FALLBACK_COLOR}
          identity={bot.id}
          status={bot.status}
          muted={!bot.notifyOnFinish}
        />
      }
    />
  );
}

function GroupRow({
  group,
  onPress,
  onLongPress,
}: {
  group: MobileGroup | SpaceGroup;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const { t } = useI18n();
  const preview =
    previewSnippet(group.preview, 40) || group.members.map((member) => member.name).join(", ");
  const time = group.updatedAt ? formatThreadTime(group.updatedAt) : "";
  return (
    <ConversationRow
      title={group.name}
      preview={preview}
      time={time}
      unread={group.unread}
      accessibilityLabel={[group.name, group.unread ? t("unread") : null, time, preview]
        .filter(Boolean)
        .join(", ")}
      accessibilityHint={onLongPress ? t("Long press to pin or move to a section") : undefined}
      onPress={onPress}
      onLongPress={onLongPress}
      avatar={<GroupAvatar members={group.members} size={54} />}
    />
  );
}

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
    searchField: {
      marginHorizontal: 16,
      marginBottom: 8,
      minHeight: 44,
      paddingVertical: 10,
      textAlignVertical: "center",
      borderRadius: 10,
      backgroundColor: native.fill,
      color: native.label,
      paddingHorizontal: 12,
      fontSize: 17,
      writingDirection: "auto",
    },
    error: {
      color: native.secondaryLabel,
      paddingHorizontal: 20,
      paddingBottom: 8,
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
      paddingHorizontal: 16,
      paddingVertical: 10,
      gap: 12,
    },
    treeToggle: {
      width: 20,
      height: 20,
      alignItems: "center",
      justifyContent: "center",
      marginRight: -4,
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
      alignItems: "center",
      gap: 8,
    },
    titleRow: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    rowMeta: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
    },
    name: {
      flexShrink: 1,
      color: native.label,
      fontSize: 17,
      fontWeight: "600",
      writingDirection: "auto",
    },
    tag: {
      flexShrink: 1,
      borderRadius: 999,
      backgroundColor: native.fill,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    tagLabel: {
      color: native.secondaryLabel,
      fontSize: 11,
      fontWeight: "500",
      writingDirection: "auto",
    },
    time: {
      color: native.secondaryLabel,
      fontSize: 15,
    },
    preview: {
      color: native.secondaryLabel,
      fontSize: 15,
      lineHeight: 20,
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
      backgroundColor: tokens.foreground,
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
    sectionHeading: {
      color: native.secondaryLabel,
      fontSize: 14,
      fontWeight: "600",
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
