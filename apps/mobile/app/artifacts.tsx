import { useFocusEffect, useNavigation, useRouter } from "expo-router";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar } from "../components/bot-avatar";
import { NativeSymbol } from "../components/native-symbol";
import { formatActivityRelativeTime } from "../lib/activity";
import { type MobileBot, rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import {
  listSpaceArtifacts,
  type MobileArtifactSummary,
  matchesArtifactQuery,
  mimeBadgeLabel,
  removeArtifact,
} from "../lib/artifacts";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";

const PAGE_SIZE = 30;

export default function ArtifactsScreen() {
  const navigation = useNavigation();
  const router = useRouter();
  const { t } = useI18n();
  const tokens = mobileTokens();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();

  const [bots, setBots] = useState<MobileBot[]>([]);
  const [activeBotId, setActiveBotId] = useState<string | null>(null);
  const [items, setItems] = useState<MobileArtifactSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const loadingMoreRef = useRef(false);
  const generationRef = useRef(0);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: t("Artifacts"),
      headerRight: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Search")}
          hitSlop={8}
          onPress={() =>
            setSearching((open) => {
              if (open) setQuery("");
              return !open;
            })
          }
          style={{ padding: 8 }}
        >
          <NativeSymbol ios="magnifyingglass" android="search" size={19} />
        </Pressable>
      ),
    });
  }, [navigation, t]);

  useFocusEffect(
    useCallback(() => {
      rpc<MobileBot[]>("bots/list")
        .then(setBots)
        .catch(() => undefined);
    }, []),
  );

  const load = useCallback(async (botId: string | null) => {
    const generation = ++generationRef.current;
    setLoadError(null);
    setItems(null);
    setNextCursor(null);
    try {
      const page = await listSpaceArtifacts({ botId: botId ?? undefined, limit: PAGE_SIZE });
      if (generation !== generationRef.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (generation !== generationRef.current) return;
      setLoadError(error instanceof Error ? error.message : t("Could not load artifacts."));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load(activeBotId);
    }, [activeBotId, load]),
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMoreRef.current) return;
    const generation = generationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await listSpaceArtifacts({
        botId: activeBotId ?? undefined,
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      if (generation !== generationRef.current) return;
      setItems((current) => (current ?? []).concat(page.items));
      setNextCursor(page.nextCursor);
    } catch {
      // Keep the existing page visible; onEndReached will retry on the next scroll.
    } finally {
      if (generation === generationRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [activeBotId, nextCursor]);

  async function refresh() {
    setRefreshing(true);
    try {
      await load(activeBotId);
    } finally {
      setRefreshing(false);
    }
  }

  function confirmDelete(item: MobileArtifactSummary) {
    Alert.alert(
      t('Delete "{name}"?', { name: item.name }),
      item.versionCount > 1
        ? t("This deletes all {count} versions of this artifact. This can't be undone.", {
            count: item.versionCount,
          })
        : t("This can't be undone."),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Delete"),
          style: "destructive",
          onPress: () =>
            void removeArtifact(item.id)
              .then(() =>
                setItems((current) => current?.filter((row) => row.id !== item.id) ?? current),
              )
              .catch((error: unknown) =>
                Alert.alert(
                  t("Could not delete this artifact"),
                  error instanceof Error ? error.message : t("Try again."),
                ),
              ),
        },
      ],
    );
  }

  const filtered = useMemo(() => {
    if (!items) return null;
    if (!searching || !query.trim()) return items;
    return items.filter((item) => matchesArtifactQuery(item, query));
  }, [items, searching, query]);

  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
      {searching ? (
        <TextInput
          autoFocus
          value={query}
          onChangeText={setQuery}
          placeholder={t("Search artifacts…")}
          placeholderTextColor={tokens.mutedForeground}
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          style={styles.searchField}
        />
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipsRow}
      >
        <Chip
          label={t("All bots")}
          active={activeBotId === null}
          onPress={() => setActiveBotId(null)}
        />
        {bots.map((bot) => (
          <Chip
            key={bot.id}
            label={bot.name}
            active={activeBotId === bot.id}
            onPress={() => setActiveBotId(bot.id)}
            avatar={<BotAvatar color={bot.color} identity={bot.id} size={16} />}
          />
        ))}
      </ScrollView>

      <FlatList<MobileArtifactSummary>
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
          ) : (
            <Text style={styles.empty}>
              {searching && query.trim() ? t("No matching artifacts") : t("No artifacts yet")}
            </Text>
          )
        }
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.footer}>
              <ActivityIndicator color={native.secondaryLabel} />
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <ArtifactRow
            item={item}
            onPress={() => router.push({ pathname: "/artifact", params: { artifactId: item.id } })}
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
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  avatar?: React.ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
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
  onPress,
  onLongPress,
}: {
  item: MobileArtifactSummary;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { t } = useI18n();
  const isCode = item.mimeType === "text/html";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.name}
      accessibilityHint={t("Long press to delete")}
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
          <Text style={styles.badge}>{mimeBadgeLabel(item.mimeType)}</Text>
        </View>
        {item.description ? (
          <Text style={styles.rowDescription} numberOfLines={1}>
            {item.description}
          </Text>
        ) : null}
        <Text style={styles.rowMeta}>{formatActivityRelativeTime(item.createdAt)}</Text>
      </View>
    </Pressable>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    centered: { alignItems: "center", justifyContent: "center", paddingTop: 40 },
    searchField: {
      marginHorizontal: 16,
      marginTop: 8,
      marginBottom: 4,
      minHeight: 40,
      paddingHorizontal: 12,
      borderRadius: 10,
      backgroundColor: native.fill,
      color: native.label,
      fontSize: 16,
    },
    chipsRow: {
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 999,
      backgroundColor: native.fill,
    },
    chipActive: { backgroundColor: tokens.primary },
    chipLabel: { color: native.label, fontSize: 13, fontWeight: "600" },
    chipLabelActive: { color: tokens.primaryForeground },
    list: { paddingBottom: 32 },
    empty: {
      color: native.secondaryLabel,
      fontSize: 15,
      textAlign: "center",
      paddingHorizontal: 24,
      paddingTop: 8,
    },
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
    rowMeta: { color: native.secondaryLabel, fontSize: 11.5 },
  });
}
