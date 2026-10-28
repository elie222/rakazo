import { withConnectionName } from "@rakazo/contracts";
import type { ChatModelChoice } from "@rakazo/core";
import { groupModelChoices } from "@rakazo/core";
import { useNavigation } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ViewToken } from "react-native";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFloatingHeaderInset } from "../lib/floating-header";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { useSideInsets } from "../lib/side-insets";
import { Checkmark } from "./row-accessories";
import { SettingsLabel, SettingsRow } from "./settings-group";
import { TextOnlyMark } from "./text-only-mark";

/** Searchable grouped model cells shared by chat and connection settings. */
export function ModelPickerList({
  choices,
  selectedKey,
  onSelect,
  error,
  providerLabel,
  emptyMessage,
  connectChoices,
}: {
  choices: readonly ChatModelChoice[] | null;
  /** Providers that need a connection first, listed after the models. */
  connectChoices?: readonly ChatModelChoice[];
  selectedKey: string;
  onSelect: (choice: ChatModelChoice) => void;
  error?: string | null;
  emptyMessage?: string;
  /** A single-provider picker only needs vendor headings. */
  providerLabel?: string;
}) {
  const { t } = useI18n();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const headerInset = useFloatingHeaderInset();
  const list = useRef<SectionList<ChatModelChoice>>(null);
  const initialScroll = useRef({
    ready: false,
    handled: false,
    cancelled: false,
    retried: false,
    target: null as { sectionIndex: number; itemIndex: number; key: string } | null,
  });
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelInitialScroll = useCallback(() => {
    initialScroll.current.cancelled = true;
    if (retry.current !== null) clearTimeout(retry.current);
  }, []);
  useEffect(
    () => () => {
      if (retry.current !== null) clearTimeout(retry.current);
    },
    [],
  );
  const [query, setQuery] = useState("");
  const changeQuery = useCallback(
    (text: string) => {
      cancelInitialScroll();
      setQuery(text);
    },
    [cancelInitialScroll],
  );
  useLayoutEffect(() => {
    if (Platform.OS === "android") return;
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: t("Search"),
        hideWhenScrolling: false,
        hideNavigationBar: false,
        autoCapitalize: "none",
        onChangeText: (event: { nativeEvent: { text: string } }) =>
          changeQuery(event.nativeEvent.text),
        onCancelButtonPress: () => changeQuery(""),
        onClose: () => changeQuery(""),
      },
    });
  }, [navigation, t, changeQuery]);

  const sections = useMemo(() => {
    if (!choices) return [];
    const models = groupModelChoices(choices, query).map((section) => ({
      ...section,
      connect: false,
      heading:
        providerLabel && section.heading === providerLabel
          ? undefined
          : providerLabel && section.heading?.endsWith(withConnectionName("", providerLabel))
            ? section.heading.slice(0, -withConnectionName("", providerLabel).length)
            : section.heading,
    }));
    const connect = groupModelChoices(
      (connectChoices ?? []).map((choice) => ({ ...choice, providerLabel: undefined })),
      query,
    ).flatMap((section) => section.data);
    return connect.length
      ? [...models, { key: "connect", heading: undefined, connect: true, data: connect }]
      : models;
  }, [choices, connectChoices, query, providerLabel]);
  useLayoutEffect(() => {
    const state = initialScroll.current;
    if (state.handled || state.cancelled || choices === null) return;
    state.ready = true;
    state.target = null;
    for (const [sectionIndex, section] of sections.entries()) {
      const itemIndex = section.data.findIndex((item) => item.key === selectedKey);
      if (itemIndex !== -1) {
        state.target = { sectionIndex, itemIndex, key: selectedKey };
        break;
      }
    }
  }, [choices, sections, selectedKey]);

  // Viewability is reported after layout, including when an async catalog arrives.
  const revealInitialSelection = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<ChatModelChoice>[] }) => {
      const state = initialScroll.current;
      if (
        !state.ready ||
        state.handled ||
        state.cancelled ||
        !viewableItems.some((item) => item.index !== null)
      )
        return;
      state.handled = true;
      if (
        !state.target ||
        viewableItems.some((item) => item.index !== null && item.item.key === state.target?.key)
      )
        return;
      list.current?.scrollToLocation({
        sectionIndex: state.target.sectionIndex,
        itemIndex: state.target.itemIndex,
        viewPosition: 0.5,
        animated: false,
      });
    },
    [],
  );

  const retryInitialSelection = useCallback(
    ({ averageItemLength, index }: { averageItemLength: number; index: number }) => {
      const state = initialScroll.current;
      if (!state.handled || state.cancelled || state.retried || !state.target) return;
      state.retried = true;
      // Move the render window near an unmeasured row before trying its location once more.
      list.current
        ?.getScrollResponder()
        ?.scrollTo({ y: averageItemLength * index, animated: false });
      retry.current = setTimeout(() => {
        if (!state.cancelled && state.target) {
          list.current?.scrollToLocation({
            sectionIndex: state.target.sectionIndex,
            itemIndex: state.target.itemIndex,
            viewPosition: 0.5,
            animated: false,
          });
        }
      }, 100);
    },
    [],
  );

  const noMatchesMessage = emptyMessage ?? t("No matching models");
  const noMatches = choices !== null && sections.length === 0;

  // The search field keeps focus, so tell screen readers once when the results run out.
  useEffect(() => {
    if (noMatches) AccessibilityInfo.announceForAccessibility(noMatchesMessage);
  }, [noMatches, noMatchesMessage]);

  return (
    <SectionList
      ref={list}
      onViewableItemsChanged={revealInitialSelection}
      onScrollToIndexFailed={retryInitialSelection}
      onScrollBeginDrag={cancelInitialScroll}
      key={Platform.OS === "android" ? "android" : query}
      style={[styles.screen, sideInsets]}
      contentContainerStyle={[
        styles.content,
        { paddingTop: headerInset + 16, paddingBottom: insets.bottom + 72 },
      ]}
      // Reserve the transparent bar explicitly: native search can drop its automatic inset.
      automaticallyAdjustKeyboardInsets
      contentInsetAdjustmentBehavior={headerInset > 0 ? "never" : "automatic"}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      sections={sections}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) =>
        section.heading ? (
          <View style={styles.sectionHeading}>
            <SettingsLabel>{section.heading}</SettingsLabel>
          </View>
        ) : null
      }
      renderSectionFooter={() => <View style={styles.sectionGap} />}
      keyExtractor={(choice) => choice.key || "space-default"}
      ItemSeparatorComponent={() => (
        <View style={styles.cell}>
          <View style={styles.separator} />
        </View>
      )}
      ListHeaderComponent={
        Platform.OS === "android" ? (
          <TextInput
            accessibilityLabel={t("Search")}
            placeholder={t("Search")}
            placeholderTextColor={native.secondaryLabel}
            value={query}
            onChangeText={changeQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={styles.search}
          />
        ) : null
      }
      ListEmptyComponent={
        error || noMatches ? (
          <Text style={styles.empty}>{error ?? noMatchesMessage}</Text>
        ) : (
          <ActivityIndicator color={native.secondaryLabel} />
        )
      }
      renderItem={({ item, index, section }) => {
        const selected = item.key === selectedKey;
        return (
          <View
            style={[
              styles.cell,
              index === 0 && styles.first,
              index === section.data.length - 1 && styles.last,
            ]}
          >
            <SettingsRow
              accessibilityRole="button"
              accessibilityLabel={item.label}
              accessibilityHint={item.images === false ? t("Can't read images") : undefined}
              accessibilityState={{ selected }}
              onPress={() => onSelect(item)}
              title={item.title ?? item.label}
              detail={item.detail}
              value={section.connect ? t("Connect") : undefined}
              chevron={section.connect ? "right" : undefined}
              trailing={
                item.images === false || selected ? (
                  <View style={styles.trailing}>
                    {item.images === false ? <TextOnlyMark /> : null}
                    {selected ? <Checkmark /> : null}
                  </View>
                ) : null
              }
            />
          </View>
        );
      }}
    />
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { paddingHorizontal: 16 },
    sectionHeading: { paddingBottom: 7 },
    sectionGap: { height: 20 },
    trailing: { flexDirection: "row", alignItems: "center", gap: 10 },
    cell: { backgroundColor: native.fill, overflow: "hidden" },
    first: { borderTopLeftRadius: 16, borderTopRightRadius: 16, borderCurve: "continuous" },
    last: { borderBottomLeftRadius: 16, borderBottomRightRadius: 16, borderCurve: "continuous" },
    separator: {
      height: StyleSheet.hairlineWidth,
      marginStart: 16,
      backgroundColor: native.separator,
    },
    search: {
      color: native.label,
      backgroundColor: native.fill,
      borderRadius: 10,
      padding: 12,
      marginBottom: 16,
      fontSize: 17,
    },
    empty: {
      color: native.secondaryLabel,
      fontSize: 15,
      paddingHorizontal: 16,
      paddingVertical: 10,
      textAlign: "center",
    },
  });
}
