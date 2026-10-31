import { StyleSheet, TextInput } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";

export function ListSearchInput({
  query,
  setQuery,
}: {
  query: string;
  setQuery: (query: string) => void;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  return (
    <TextInput
      accessibilityLabel={t("Search")}
      placeholder={t("Search")}
      placeholderTextColor={native.secondaryLabel}
      value={query}
      onChangeText={setQuery}
      autoCapitalize="none"
      autoCorrect={false}
      returnKeyType="search"
      style={styles.search}
    />
  );
}
function createStyles() {
  return StyleSheet.create({
    search: {
      color: native.label,
      backgroundColor: native.fill,
      borderRadius: 10,
      padding: 12,
      marginBottom: 16,
      fontSize: 17,
    },
  });
}
