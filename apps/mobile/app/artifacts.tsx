import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { artifactTypeLabel } from "@rakazo/core";
import {
  useFocusEffect,
  useIsFocused,
  useLocalSearchParams,
  useNavigation,
  useRouter,
} from "expo-router";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LayoutChangeEvent, ScrollViewInstance } from "react-native";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { BotAvatar } from "../components/bots/bot-avatar";
import { NativeSegmentedControl } from "../components/native/native-segmented-control";
import { NativeSymbol } from "../components/native/native-symbol";
import type { MobileBot } from "../lib/api/mobile-types";
import { useSpaceChanges } from "../lib/api/roster-signals";
import { errorText } from "../lib/api/user-error";
import { mobileTokens } from "../lib/appearance/appearance";
import { isMediaArtifact, mediaArtifactGallery } from "../lib/artifacts/artifact-gallery";
import type { MobileArtifactSummary } from "../lib/artifacts/artifacts";
import {
  listSpaceArtifacts,
  matchesArtifactQuery,
  removeArtifact,
} from "../lib/artifacts/artifacts";
import { formatActivityRelativeTime } from "../lib/inbox/activity";
import { useContentBottomInset } from "../lib/layout/content-bottom-inset";
import { useSideInsets } from "../lib/layout/side-insets";
import { native, useThemedStyles } from "../lib/native/native";
import { rpcQuery } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";
import { useBackToSettings } from "../lib/settings/back-to-settings";

const PAGE_SIZE = 30;

export default function ArtifactsScreen() {
  useBackToSettings();
  const sideInsets = useSideInsets();
  const navigation = useNavigation();
  const router = useRouter();
  const focused = useIsFocused();
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const contentBottomInset = useContentBottomInset();

  const bots = useScreenQuery(rpcQuery("bots/list")).data;
  const { botId } = useLocalSearchParams<{ botId?: string }>();
  const [activeBotId, setActiveBotId] = useState<string | null>(botId || null);
  const [madeByBots, setMadeByBots] = useState(false);
  const chipsScrollRef = useRef<ScrollViewInstance>(null);
  const initialChipLayout = useRef({
    viewportWidth: 0,
    contentWidth: 0,
    chip: null as { x: number; width: number } | null,
    revealed: false,
  });

  function revealInitialChip() {
    const layout = initialChipLayout.current;
    if (layout.revealed || !layout.viewportWidth || !layout.chip) return;
    const right = layout.chip.x + layout.chip.width;
    if (layout.contentWidth < right) return;
    chipsScrollRef.current?.scrollTo({
      x: Math.max(0, right - layout.viewportWidth),
      animated: false,
    });
    layout.revealed = true;
  }

  const [items, setItems] = useState<MobileArtifactSummary[] | null>(null);
  const [next, setNext] = useState<{
    cursor: string;
    botId: string | null;
    madeByBots: boolean;
  } | null>(null);
  const nextCursor =
    next?.botId === activeBotId && next.madeByBots === madeByBots ? next.cursor : null;
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchPageFailed, setSearchPageFailed] = useState(false);
  const loadingMoreRef = useRef(false);
  const pullingRef = useRef(false);
  const loadedPagesRef = useRef(1);
  const generationRef = useRef(0);
  const loadingPageRef = useRef(false);
  const [loadingPage, setLoadingPage] = useState(false);
  const autoFetchedCursorRef = useRef<string | null>(null);
  const activeBotIdRef = useRef(activeBotId);
  const madeByBotsRef = useRef(madeByBots);
  const didFocusRef = useRef(false);
  activeBotIdRef.current = activeBotId;
  madeByBotsRef.current = madeByBots;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: t`Search artifacts…`,
        hideWhenScrolling: false,
        autoCapitalize: "none",
        onChangeText: (event: { nativeEvent: { text: string } }) =>
          setQuery(event.nativeEvent.text),
        onCancelButtonPress: () => setQuery(""),
        onClose: () => setQuery(""),
      },
    });
  }, [navigation, t]);

  const load = useCallback(
    async (botId: string | null, madeByBots: boolean, mode: "replace" | "refresh" | "live") => {
      // A read that starts during a pull-to-refresh supersedes it, so it reports its failure.
      const forPull = pullingRef.current;
      const pageCount = mode === "live" ? loadedPagesRef.current : 1;
      const generation = ++generationRef.current;
      loadingPageRef.current = true;
      setLoadingPage(true);
      loadingMoreRef.current = false;
      setLoadingMore(false);
      autoFetchedCursorRef.current = null;
      setSearchPageFailed(false);
      setLoadError(null);
      if (mode === "replace") {
        setRefreshError(null);
        loadedPagesRef.current = 1;
        setItems(null);
        setNext(null);
      }
      try {
        const input = {
          botId: botId ?? undefined,
          madeByBots,
          limit: PAGE_SIZE,
        };
        let page = await listSpaceArtifacts(input);
        const nextItems = [...page.items];
        let loaded = 1;
        while (loaded < pageCount && page.nextCursor && generation === generationRef.current) {
          page = await listSpaceArtifacts({ ...input, cursor: page.nextCursor });
          nextItems.push(...page.items);
          loaded++;
        }
        if (generation !== generationRef.current) return;
        loadedPagesRef.current = loaded;
        setItems(nextItems);
        setNext(page.nextCursor ? { cursor: page.nextCursor, botId, madeByBots } : null);
        setRefreshError(null);
      } catch (error) {
        if (generation !== generationRef.current) return;
        const message = errorText(error, t`Could not load artifacts.`);
        setLoadError(message);
        if (forPull) setRefreshError(message);
      } finally {
        if (generation === generationRef.current) {
          loadingPageRef.current = false;
          setLoadingPage(false);
        }
      }
    },
    [t],
  );

  useFocusEffect(
    useCallback(() => {
      if (!didFocusRef.current) {
        didFocusRef.current = true;
        return;
      }
      void load(activeBotIdRef.current, madeByBotsRef.current, "refresh");
    }, [load]),
  );
  useSpaceChanges(
    "artifacts",
    () => load(activeBotIdRef.current, madeByBotsRef.current, "live"),
    focused,
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMoreRef.current || loadingPageRef.current) return;
    const generation = generationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await listSpaceArtifacts({
        botId: activeBotId ?? undefined,
        madeByBots,
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      if (generation !== generationRef.current) return;
      loadedPagesRef.current++;
      setItems((current) => (current ?? []).concat(page.items));
      setNext(page.nextCursor ? { cursor: page.nextCursor, botId: activeBotId, madeByBots } : null);
      setSearchPageFailed(false);
    } catch {
      if (generation === generationRef.current) setSearchPageFailed(true);
    } finally {
      if (generation === generationRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [activeBotId, madeByBots, nextCursor]);

  async function refresh() {
    if (pullingRef.current) return;
    setRefreshing(true);
    pullingRef.current = true;
    try {
      await load(activeBotId, madeByBots, "refresh");
    } finally {
      pullingRef.current = false;
      setRefreshing(false);
    }
  }

  function confirmDelete(item: MobileArtifactSummary) {
    Alert.alert(
      t`Delete "${ph({ name: item.name })}"?`,
      item.versionCount > 1
        ? t`This deletes all ${ph({ count: item.versionCount })} versions of this artifact. This can't be undone.`
        : t`This can't be undone.`,
      [
        { text: t`Cancel`, style: "cancel" },
        {
          text: t`Delete`,
          style: "destructive",
          onPress: () =>
            void removeArtifact(item.id)
              .then(() => {
                setItems((current) => current?.filter((row) => row.id !== item.id) ?? current);
                void load(activeBotIdRef.current, madeByBotsRef.current, "refresh");
              })
              .catch((error: unknown) =>
                Alert.alert(t`Could not delete this artifact`, errorText(error, t`Try again.`)),
              ),
        },
      ],
    );
  }

  const queryActive = query.trim().length > 0;
  const filtered = useMemo(() => {
    if (!items) return null;
    if (!queryActive) return items;
    return items.filter((item) => matchesArtifactQuery(item, query));
  }, [items, query, queryActive]);
  const mediaGallery = useMemo(() => mediaArtifactGallery(filtered ?? []), [filtered]);
  const mediaGalleryParam = useMemo(
    () => (mediaGallery.length > 1 ? JSON.stringify(mediaGallery) : undefined),
    [mediaGallery],
  );
  const botsById = useMemo(() => new Map((bots ?? []).map((bot) => [bot.id, bot])), [bots]);

  useEffect(() => {
    autoFetchedCursorRef.current = null;
    setSearchPageFailed(false);
  }, [query, activeBotId, madeByBots]);

  useEffect(() => {
    if (
      loadingPage ||
      searchPageFailed ||
      !queryActive ||
      !nextCursor ||
      loadingMore ||
      items === null
    )
      return;
    if (filtered && filtered.length > 0) return;
    if (autoFetchedCursorRef.current === nextCursor) return;
    autoFetchedCursorRef.current = nextCursor;
    void loadMore();
  }, [
    filtered,
    items,
    loadMore,
    loadingMore,
    loadingPage,
    nextCursor,
    queryActive,
    searchPageFailed,
  ]);

  useEffect(() => {
    void load(activeBotId, madeByBots, "replace");
  }, [activeBotId, madeByBots, load]);

  return (
    <View style={[styles.screen, { paddingBottom: contentBottomInset }]}>
      <FlatList<MobileArtifactSummary>
        ListHeaderComponent={
          <View>
            <View style={styles.sourceControl}>
              <NativeSegmentedControl
                accessibilityLabel={t`Filter by who made it`}
                value={madeByBots ? "bots" : "all"}
                onChange={(value) => setMadeByBots(value === "bots")}
                options={[
                  { value: "all" as const, label: t`All files` },
                  { value: "bots" as const, label: t`Made by bots` },
                ]}
              />
            </View>
            <ScrollView
              ref={chipsScrollRef}
              onLayout={(event) => {
                initialChipLayout.current.viewportWidth = event.nativeEvent.layout.width;
                revealInitialChip();
              }}
              onContentSizeChange={(width) => {
                initialChipLayout.current.contentWidth = width;
                revealInitialChip();
              }}
              horizontal
              contentInsetAdjustmentBehavior="never"
              showsHorizontalScrollIndicator={false}
              style={styles.chipsScroll}
              contentContainerStyle={styles.chipsRow}
            >
              <Chip
                label={t`All bots`}
                active={activeBotId === null}
                onPress={() => setActiveBotId(null)}
              />
              {(bots ?? []).map((bot) => (
                <Chip
                  key={bot.id}
                  onLayout={
                    bot.id === botId && activeBotId === botId
                      ? (event) => {
                          initialChipLayout.current.chip = event.nativeEvent.layout;
                          revealInitialChip();
                        }
                      : undefined
                  }
                  label={bot.name}
                  active={activeBotId === bot.id}
                  onPress={() => setActiveBotId(bot.id)}
                  avatar={
                    <BotAvatar
                      color={bot.color}
                      avatarSet={bot.avatarSet}
                      identity={bot.id}
                      size={16}
                    />
                  }
                />
              ))}
            </ScrollView>
            {items !== null && refreshError ? (
              <Text accessibilityRole="alert" style={[styles.empty, styles.refreshError]}>
                {refreshError}
              </Text>
            ) : null}
          </View>
        }
        style={[styles.listView, sideInsets]}
        contentInsetAdjustmentBehavior="automatic"
        data={filtered ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        indicatorStyle="default"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={native.secondaryLabel}
          />
        }
        onEndReachedThreshold={0.4}
        onEndReached={() => void loadMore()}
        ListEmptyComponent={
          items === null ? (
            <View style={styles.centered}>
              {loadError ? (
                <Text style={styles.empty}>{loadError}</Text>
              ) : (
                <ActivityIndicator color={native.secondaryLabel} />
              )}
            </View>
          ) : queryActive && filtered?.length === 0 && nextCursor && searchPageFailed ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                autoFetchedCursorRef.current = null;
                setSearchPageFailed(false);
              }}
              style={styles.centered}
            >
              <Text style={styles.empty}>{t`Could not load artifacts.`}</Text>
              <Text style={styles.empty}>{t`Try again.`}</Text>
            </Pressable>
          ) : queryActive &&
            filtered?.length === 0 &&
            nextCursor &&
            (loadingMore || autoFetchedCursorRef.current !== nextCursor) ? (
            <View style={styles.centered}>
              <ActivityIndicator color={native.secondaryLabel} />
            </View>
          ) : (
            <Text style={styles.empty}>
              {queryActive || madeByBots ? t`No matching artifacts` : t`No artifacts yet`}
            </Text>
          )
        }
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.footer}>
              <ActivityIndicator color={native.secondaryLabel} />
            </View>
          ) : undefined
        }
        renderItem={({ item }) => (
          <ArtifactRow
            item={item}
            bot={activeBotId === null && item.botId ? botsById.get(item.botId) : undefined}
            onPress={() =>
              router.push({
                pathname: "/artifact",
                params: {
                  artifactId: item.id,
                  ...(mediaGalleryParam && isMediaArtifact(item)
                    ? { gallery: mediaGalleryParam }
                    : {}),
                },
              })
            }
            onLongPress={() => confirmDelete(item)}
          />
        )}
      />
    </View>
  );
}

function Chip({
  label,
  active,
  onPress,
  avatar,
  onLayout,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  avatar?: ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      onLayout={onLayout}
      style={[styles.chip, active && styles.chipActive]}
    >
      {avatar}
      <Text style={[styles.chipLabel, active && styles.chipLabelActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function ArtifactRow({
  item,
  bot,
  onPress,
  onLongPress,
}: {
  item: MobileArtifactSummary;
  bot?: MobileBot;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { t } = useLingui();
  const isCode = item.mimeType === "text/html";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={bot ? `${item.name}, ${bot.name}` : item.name}
      accessibilityHint={t`Long press to delete`}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowIcon}>
        <NativeSymbol
          ios={isCode ? "chevron.left.forwardslash.chevron.right" : "doc.text"}
          android={isCode ? "code-slash-outline" : "document-text-outline"}
          size={16}
        />
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.rowName} numberOfLines={1}>
            {item.name}
          </Text>
          {item.versionCount > 1 ? <Text style={styles.badge}>{`v${item.version}`}</Text> : null}
          <Text style={styles.badge}>{artifactTypeLabel(item.mimeType)}</Text>
        </View>
        {item.description ? (
          <Text style={styles.rowDescription} numberOfLines={1}>
            {item.description}
          </Text>
        ) : null}
        <View style={styles.rowFooter}>
          {bot ? (
            <>
              <BotAvatar color={bot.color} avatarSet={bot.avatarSet} identity={bot.id} size={14} />
              <Text style={styles.rowBotName} numberOfLines={1}>
                {bot.name}
              </Text>
            </>
          ) : null}
          <Text style={styles.rowMeta}>{formatActivityRelativeTime(item.createdAt)}</Text>
        </View>
      </View>
    </Pressable>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    centered: { alignItems: "center", justifyContent: "center", paddingTop: 40 },
    sourceControl: { paddingHorizontal: 16, paddingTop: 10 },
    chipsScroll: { flexGrow: 0, flexShrink: 0 },
    chipsRow: {
      flexDirection: "row",
      alignItems: "center",
      flexGrow: 0,
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      flexGrow: 0,
      flexShrink: 0,
      gap: 6,
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 999,
      backgroundColor: native.fill,
    },
    chipActive: { backgroundColor: tokens.primary },
    chipLabel: { color: native.label, fontSize: 13, fontWeight: "600" },
    chipLabelActive: { color: tokens.primaryForeground },
    listView: { flex: 1 },
    list: { paddingBottom: 32 },
    empty: {
      color: native.secondaryLabel,
      fontSize: 15,
      textAlign: "center",
      paddingHorizontal: 24,
      paddingTop: 8,
    },
    refreshError: { color: tokens.destructive, paddingBottom: 8 },
    footer: { paddingVertical: 20 },
    row: { flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
    rowPressed: { opacity: 0.6 },
    rowIcon: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: native.fill,
      alignItems: "center",
      justifyContent: "center",
    },
    rowBody: { flex: 1, minWidth: 0, gap: 3 },
    rowTop: { flexDirection: "row", alignItems: "center", gap: 6 },
    rowName: { flex: 1, minWidth: 0, color: native.label, fontSize: 15, fontWeight: "600" },
    badge: {
      color: native.secondaryLabel,
      fontSize: 10.5,
      fontWeight: "700",
      backgroundColor: native.fill,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
      overflow: "hidden",
    },
    rowDescription: { color: native.secondaryLabel, fontSize: 12.5 },
    rowFooter: { flexDirection: "row", alignItems: "center", gap: 6 },
    rowBotName: { flexShrink: 1, color: native.secondaryLabel, fontSize: 11.5 },
    rowMeta: { color: native.secondaryLabel, fontSize: 11.5 },
  });
}
