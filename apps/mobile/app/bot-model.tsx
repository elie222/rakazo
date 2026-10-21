import type { ChatModelChoice } from "@rakazo/core";
import { groupModelChoices } from "@rakazo/core";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Checkmark } from "../components/row-accessories";
import { SettingsLabel, SettingsRow } from "../components/settings-group";
import type { MobileMe, MobileModel, MobileModelCredential } from "../lib/api";
import { rpc } from "../lib/api";
import { chatModelPickerChoices } from "../lib/chat-model";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { errorText } from "../lib/user-error";

/** A chat's model, from a list too long for a menu, with the system search field. */
export default function BotModelScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(createStyles);
  const { botId, value = "" } = useLocalSearchParams<{ botId: string; value?: string }>();
  const [choices, setChoices] = useState<ChatModelChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void Promise.all([
      rpc<MobileMe>("me"),
      rpc<MobileModel[]>("models/list"),
      rpc<MobileModelCredential[]>("models/credentials"),
    ])
      .then(([me, catalog, credentials]) =>
        setChoices(chatModelPickerChoices(me, catalog, credentials, value, t)),
      )
      .catch((err) => setError(errorText(err, t("Could not load model settings"))));
  }, [t, value]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: t("Search"),
        hideWhenScrolling: false,
        autoCapitalize: "none",
        onChangeText: (event: { nativeEvent: { text: string } }) =>
          setQuery(event.nativeEvent.text),
        onCancelButtonPress: () => setQuery(""),
        onClose: () => setQuery(""),
      },
    });
  }, [navigation, t]);

  const sections = useMemo(
    () => (choices ? groupModelChoices(choices, query) : []),
    [choices, query],
  );
  const noMatches = choices !== null && sections.length === 0;

  // The search field keeps focus, so tell screen readers once when the results run out.
  useEffect(() => {
    if (noMatches) AccessibilityInfo.announceForAccessibility(t("No matching models"));
  }, [noMatches, t]);

  return (
    <SectionList
      key={query}
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 72 }]}
      // Reserve the floating search field; UIKit adds the keyboard and header insets.
      automaticallyAdjustKeyboardInsets
      contentInsetAdjustmentBehavior="automatic"
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
      ListEmptyComponent={
        error || noMatches ? (
          <Text style={styles.empty}>{error ?? t("No matching models")}</Text>
        ) : (
          <ActivityIndicator color={native.secondaryLabel} />
        )
      }
      renderItem={({ item, index, section }) => {
        const selected = item.key === value;
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
              accessibilityState={{ selected }}
              onPress={() =>
                router.dismissTo({ pathname: "/bot-settings", params: { botId, model: item.key } })
              }
              title={item.title ?? item.label}
              detail={item.detail}
              trailing={selected ? <Checkmark /> : null}
            />
          </View>
        );
      }}
    />
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { paddingHorizontal: 16, paddingTop: 16 },
    sectionHeading: { paddingBottom: 7 },
    sectionGap: { height: 20 },
    cell: { backgroundColor: native.groupedCell, overflow: "hidden" },
    first: { borderTopLeftRadius: 16, borderTopRightRadius: 16, borderCurve: "continuous" },
    last: { borderBottomLeftRadius: 16, borderBottomRightRadius: 16, borderCurve: "continuous" },
    separator: {
      height: StyleSheet.hairlineWidth,
      marginStart: 16,
      backgroundColor: native.separator,
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
