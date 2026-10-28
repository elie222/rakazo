import { useNavigation } from "expo-router";
import { useLayoutEffect } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { createHomeStyles } from "./home-styles";

/** The index route on a split window, where the chat list sits beside this pane. */
export function PickChatPane() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useI18n();
  useLayoutEffect(() => {
    // Home restores its native controls when the compact inbox mounts again.
    navigation.setOptions({ headerShown: false });
  }, [navigation]);
  return (
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
  );
}
