import { Redirect, useRouter } from "expo-router";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar } from "../components/bot-avatar";
import { NativeSymbol } from "../components/native-symbol";
import { loadSessionToken, type MobileBot, type MobileMe, rpc } from "../lib/api";
import { botTag, filterBots, formatThreadTime, userInitials } from "../lib/inbox";
import { native } from "../lib/native";
import { previewSnippet } from "../lib/preview";
import { registerPushToken } from "../lib/push";

const FALLBACK_COLOR = "#9B5CF6";

export default function Home() {
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [me, setMe] = useState<MobileMe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

  const loadBots = useCallback(async () => {
    setError(null);
    try {
      setBots(await rpc<MobileBot[]>("bots/list"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load bots");
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
    void loadBots();
    void rpc<MobileMe>("me")
      .then(setMe)
      .catch(() => undefined);
  }, [hasSession, loadBots]);

  const visible = useMemo(() => filterBots(bots, query), [bots, query]);
  const initials = userInitials(me?.name ?? "");
  const insets = useSafeAreaInsets();
  const router = useRouter();

  if (!ready) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <ActivityIndicator color={native.secondaryLabel} />
      </View>
    );
  }
  if (!hasSession) return <Redirect href="/sign-in" />;

  return (
    <View style={[styles.screen, { paddingTop: Math.max(insets.top, 20) }]}>
      <View style={styles.header}>
        <CircleButton accessibilityLabel="Account" onPress={() => router.push("/account")}>
          <Text style={styles.profileInitials}>{initials}</Text>
        </CircleButton>
        <View style={styles.headerActions}>
          <CircleButton
            accessibilityLabel="Search"
            active={searching}
            onPress={() =>
              setSearching((open) => {
                if (open) setQuery("");
                return !open;
              })
            }
          >
            <NativeSymbol ios="magnifyingglass" android="search" size={17} />
          </CircleButton>
          <CircleButton accessibilityLabel="New bot" onPress={() => router.push("/new")}>
            <NativeSymbol ios="plus" android="add" size={18} />
          </CircleButton>
        </View>
      </View>

      {searching ? (
        <TextInput
          autoFocus
          value={query}
          onChangeText={setQuery}
          placeholder="Search"
          placeholderTextColor="#6C6C70"
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          keyboardAppearance="dark"
          clearButtonMode="while-editing"
          style={styles.searchField}
        />
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        data={visible}
        keyExtractor={(bot) => bot.id}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        indicatorStyle="white"
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refreshBots()}
            tintColor={native.secondaryLabel}
            colors={["#8E8E93"]}
            progressBackgroundColor="#1C1C1E"
          />
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            {query.trim()
              ? "No matching bots"
              : searching
                ? "Search your bots"
                : "Tap + to create a bot"}
          </Text>
        }
        renderItem={({ item }) => <BotRow bot={item} />}
      />
    </View>
  );
}

function CircleButton({
  children,
  onPress,
  accessibilityLabel,
  active = false,
}: {
  children: ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
  active?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.circleButton, (active || pressed) && styles.circlePressed]}
    >
      {children}
    </Pressable>
  );
}

function BotRow({ bot }: { bot: MobileBot }) {
  const router = useRouter();
  const preview = previewSnippet(bot.preview, 40) || bot.title || "No messages yet";
  const time = bot.updatedAt ? formatThreadTime(bot.updatedAt) : "";
  const tag = botTag(bot.title, bot.name);
  return (
    <Pressable
      onPress={() =>
        router.push({ pathname: "/thread", params: { botId: bot.id, name: bot.name } })
      }
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <BotAvatar color={bot.color || FALLBACK_COLOR} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <View style={styles.titleRow}>
            <Text style={styles.name} numberOfLines={1} ellipsizeMode="tail">
              {bot.name}
            </Text>
            {tag ? (
              <View style={styles.tag}>
                <Text style={styles.tagLabel} numberOfLines={1} ellipsizeMode="tail">
                  {tag}
                </Text>
              </View>
            ) : null}
          </View>
          {time ? <Text style={styles.time}>{time}</Text> : null}
        </View>
        <Text style={styles.preview} numberOfLines={1} ellipsizeMode="tail">
          {preview}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
    gap: 12,
  },
  circleButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#2C2C2E",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  circlePressed: {
    backgroundColor: "#3A3A3C",
  },
  profileInitials: {
    color: native.label,
    fontSize: 15,
    fontWeight: "600",
  },
  searchField: {
    marginHorizontal: 16,
    marginBottom: 8,
    height: 36,
    borderRadius: 10,
    backgroundColor: native.fill,
    color: native.label,
    paddingHorizontal: 12,
    fontSize: 17,
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
  name: {
    flexShrink: 1,
    color: native.label,
    fontSize: 17,
    fontWeight: "600",
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
  },
  time: {
    color: native.secondaryLabel,
    fontSize: 15,
  },
  preview: {
    color: native.secondaryLabel,
    fontSize: 15,
    lineHeight: 20,
  },
});
