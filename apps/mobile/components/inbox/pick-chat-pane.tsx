import { useLingui } from "@lingui/react/macro";
import { useNavigation } from "expo-router";
import { useLayoutEffect } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useContentBottomInset } from "../../lib/layout/content-bottom-inset";
import { useThemedStyles } from "../../lib/native/native";
import { createInboxStyles } from "./inbox-styles";

/** The index route on a split window, where the chat list sits beside this pane. */
export function PickChatPane() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const contentBottomInset = useContentBottomInset();
  const styles = useThemedStyles(createInboxStyles);
  const { t } = useLingui();
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
          paddingBottom: contentBottomInset,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        },
      ]}
    >
      <Text style={styles.emptyPane}>{t`Pick a chat`}</Text>
    </View>
  );
}
