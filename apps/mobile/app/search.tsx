import { useLingui } from "@lingui/react/macro";
import { botColors, fontWeight, typeScale } from "@rakazo/ui-tokens";
import type { NativeStackNavigationProp } from "expo-router";
import { useFocusEffect, useNavigation, useRouter } from "expo-router";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { TextInputInstance } from "react-native";
import {
  Alert,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar } from "../components/bot-avatar";
import { GlassIconButton } from "../components/glass-icon-button";
import { GroupAvatar } from "../components/group-avatar";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSymbol } from "../components/native-symbol";
import { readableGutters } from "../lib/adaptive-layout";
import { currentApiBase, selectedSpaceId, spaceSelectionSeq } from "../lib/api";
import { selectSpace } from "../lib/api-server";
import { mobileTokens, resolveMobileAppearance } from "../lib/appearance";
import { CallKeyboardContext } from "../lib/call-keyboard-context";
import { useContentBottomInset } from "../lib/content-bottom-inset";
import { useUiLocale } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { getSearchInbox, subscribeSearchInbox } from "../lib/search-inbox";
import type { SearchSheetRow } from "../lib/search-sheet";
import { searchSheetRows } from "../lib/search-sheet";
import { currentSessionGeneration } from "../lib/session";
import { useSearch } from "../lib/use-search";

const kindIcons = {
  conversation: { ios: "bubble.left.and.bubble.right", android: "chatbubbles-outline" },
  message: { ios: "bubble.left", android: "chatbubble-outline" },
  file: { ios: "doc", android: "document-outline" },
  link: { ios: "link", android: "link-outline" },
  routine: { ios: "clock.arrow.circlepath", android: "time-outline" },
} as const;

// Result rows match the inbox rows.
const RESULT_AVATAR = 52;

export default function SearchSheet() {
  const { t } = useLingui();
  const locale = useUiLocale();
  const router = useRouter();
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const styles = useThemedStyles(createStyles);
  const tokens = mobileTokens();
  const appearance = resolveMobileAppearance();
  const insets = useSafeAreaInsets();
  const contentBottomInset = useContentBottomInset();
  const rootAvoidsKeyboard = useContext(CallKeyboardContext);
  const gutters = readableGutters(useWindowDimensions().width, insets);
  const field = useRef<TextInputInstance>(null);
  const opening = useRef(false);
  const attempt = useRef(0);
  const focused = useRef(false);
  const [query, setQuery] = useState("");
  const spaces = useSyncExternalStore(subscribeSearchInbox, getSearchInbox);
  const { hits, loading, error, retry } = useSearch(query);
  const rows = useMemo(() => searchSheetRows(spaces, query, hits), [spaces, query, hits, locale]);

  const cancelOpen = useCallback(() => {
    attempt.current += 1;
    focused.current = false;
    opening.current = true;
  }, []);

  useFocusEffect(
    useCallback(() => {
      const arm = () => {
        focused.current = true;
        opening.current = false;
      };
      arm();
      // A native dismissal blurs the sheet only once its animation ends, so a pending open is
      // cancelled as soon as the sheet starts closing, and re-armed if the gesture is abandoned.
      const unsubscribe = navigation.addListener("transitionStart", (event) => {
        if (event.data.closing) cancelOpen();
        else arm();
      });
      return () => {
        cancelOpen();
        unsubscribe();
      };
    }, [navigation, cancelOpen]),
  );

  useEffect(() => {
    // Native formSheet may finish attaching after TextInput's autoFocus runs.
    const timer = setTimeout(() => {
      if (focused.current && !opening.current) field.current?.focus();
    }, 350);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  const open = async (row: SearchSheetRow) => {
    if (!focused.current || opening.current) return;
    opening.current = true;
    const currentAttempt = ++attempt.current;
    const isCurrent = () => focused.current && attempt.current === currentAttempt;
    const previousSpaceId = selectedSpaceId();
    const generation = currentSessionGeneration();
    const apiBase = currentApiBase();
    let selected = false;
    let selectionSeq: number | undefined;
    let navigated = false;
    try {
      if (row.spaceId) {
        const selection = selectSpace(row.spaceId);
        selectionSeq = spaceSelectionSeq();
        selected = await selection;
        if (
          !isCurrent() ||
          selectionSeq !== spaceSelectionSeq() ||
          (selected && selectedSpaceId() !== row.spaceId)
        )
          return;
        if (!selected) {
          Alert.alert(t`Could not switch spaces`, t`Try again.`);
          return;
        }
      }
      await KeyboardController.dismiss();
      if (
        !isCurrent() ||
        (selectionSeq !== undefined &&
          (selectionSeq !== spaceSelectionSeq() || selectedSpaceId() !== row.spaceId))
      )
        return;
      // Replace removes the sheet from history while preserving messageId search jumps.
      navigated = true;
      router.replace(row.destination);
    } finally {
      // Native dismissal can outlive the switch; newer selections (even pending) own it now.
      if (
        !navigated &&
        !isCurrent() &&
        selected &&
        selectionSeq === spaceSelectionSeq() &&
        previousSpaceId !== row.spaceId &&
        selectedSpaceId() === row.spaceId &&
        generation === currentSessionGeneration() &&
        apiBase === currentApiBase()
      ) {
        await selectSpace(previousSpaceId ?? "").catch(() => false);
      }
      if (isCurrent()) opening.current = false;
    }
  };

  // Preserve this container so the native sheet does not stretch the list over the header.
  return (
    <View
      collapsable={false}
      style={[styles.screen, { paddingTop: Platform.OS === "ios" ? 16 : insets.top + 8 }]}
    >
      <View
        style={[styles.top, { marginLeft: 16 + gutters.left, marginRight: 16 + gutters.right }]}
      >
        <GlassIconButton
          testID="search-sheet-close"
          accessibilityLabel={t`Close`}
          ios="xmark"
          android="close"
          onPress={() => {
            cancelOpen();
            router.back();
          }}
        />
        <View style={styles.fieldPill}>
          <NativeSymbol
            ios="magnifyingglass"
            android="search"
            size={24}
            color={tokens.mutedForeground}
          />
          <TextInput
            ref={field}
            testID="search-sheet-field"
            accessibilityLabel={t`Search`}
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder={t`Search`}
            placeholderTextColor={tokens.mutedForeground}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            keyboardAppearance={appearance}
            clearButtonMode="while-editing"
            style={styles.field}
          />
          {Platform.OS === "android" && query ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t`Clear`}
              hitSlop={8}
              onPress={() => {
                setQuery("");
                field.current?.focus();
              }}
              style={({ pressed }) => [styles.clear, pressed && styles.pressed]}
            >
              <NativeSymbol
                ios="xmark.circle.fill"
                android="close-circle"
                size={20}
                color={tokens.mutedForeground}
              />
            </Pressable>
          ) : null}
        </View>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        automaticallyAdjustKeyboardInsets={!rootAvoidsKeyboard}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingLeft: gutters.left,
          paddingRight: gutters.right,
          paddingBottom: contentBottomInset + 16,
        }}
        ListEmptyComponent={
          error ? undefined : (
            <Text style={styles.empty}>{loading ? t`Searching…` : t`No results`}</Text>
          )
        }
        ListFooterComponent={
          error ? (
            <View style={styles.failure}>
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
              <NativeActionButton
                label={t`Try again`}
                prominence="secondary"
                size="compact"
                onPress={retry}
              />
            </View>
          ) : undefined
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={[item.title, item.label, item.preview].filter(Boolean).join(", ")}
            onPress={() => void open(item)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            {item.group ? (
              <GroupAvatar members={item.group.members} size={RESULT_AVATAR} />
            ) : item.bot ? (
              <BotAvatar
                identity={item.bot.id}
                color={item.bot.color || botColors[3]}
                avatarSet={item.bot.avatarSet}
                status={item.bot.status}
                size={RESULT_AVATAR}
              />
            ) : (
              <View style={styles.neutralAvatar}>
                <NativeSymbol {...kindIcons[item.kind]} color={tokens.mutedForeground} size={24} />
              </View>
            )}
            <View style={styles.body}>
              <View style={styles.rowTop}>
                <Text numberOfLines={1} style={styles.name}>
                  {item.title}
                </Text>
                <Text style={styles.time}>{item.label}</Text>
              </View>
              {/* Two lines, so the matched words fit after the text before them. */}
              <Text numberOfLines={2} style={styles.preview}>
                {item.preview}
              </Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    top: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
    fieldPill: {
      flex: 1,
      height: 56,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderRadius: 28,
      borderWidth: 1,
      borderColor: tokens.glassStroke,
      paddingHorizontal: 20,
      backgroundColor: tokens.glassFill,
    },
    field: {
      flex: 1,
      minHeight: 44,
      paddingVertical: 10,
      color: native.label,
      fontSize: 18,
      writingDirection: "auto",
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 24,
      paddingVertical: 12,
      gap: 16,
    },
    pressed: { opacity: 0.55 },
    clear: { minWidth: 32, minHeight: 44, alignItems: "center", justifyContent: "center" },
    neutralAvatar: {
      width: RESULT_AVATAR,
      height: RESULT_AVATAR,
      borderRadius: RESULT_AVATAR / 2,
      backgroundColor: tokens.muted,
      alignItems: "center",
      justifyContent: "center",
    },
    body: { flex: 1, minWidth: 0, gap: 2 },
    rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
    // Result rows match the inbox rows.
    name: {
      flex: 1,
      color: native.label,
      ...typeScale.cardTitle,
      fontWeight: fontWeight.regular,
      writingDirection: "auto",
    },
    time: { color: native.secondaryLabel, ...typeScale.caption },
    preview: {
      color: native.secondaryLabel,
      ...typeScale.secondary,
      writingDirection: "auto",
    },
    empty: {
      color: native.secondaryLabel,
      ...typeScale.secondary,
      paddingHorizontal: 24,
      paddingTop: 28,
    },
    failure: { alignItems: "flex-start", gap: 12, paddingHorizontal: 24, paddingTop: 28 },
    error: { color: tokens.destructive, fontSize: 14 },
  });
}
