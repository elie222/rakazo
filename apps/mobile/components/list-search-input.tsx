import { useLingui } from "@lingui/react/macro";
import { StyleSheet, TextInput } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { native, useThemedStyles } from "../lib/native";

export function ListSearchInput({
  query,
  setQuery,
}: {
  query: string;
  setQuery: (query: string) => void;
}) {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  return (
    <TextInput
      accessibilityLabel={t`Search`}
      placeholder={t`Search`}
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
  const tokens = mobileTokens();
  return StyleSheet.create({
    search: {
      height: 56,
      color: native.label,
      backgroundColor: tokens.glassFill,
      borderWidth: 1,
      borderColor: tokens.glassStroke,
      borderRadius: 28,
      paddingHorizontal: 20,
      marginBottom: 16,
      fontSize: 18,
    },
  });
}
