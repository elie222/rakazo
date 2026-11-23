import { useLingui } from "@lingui/react/macro";
import { useNavigation } from "expo-router";
import { useLayoutEffect } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useContentBottomInset } from "../../lib/layout/content-bottom-inset";
import { useSplitView } from "../../lib/layout/split-view";
import { useThemedStyles } from "../../lib/native/native";
import { GlassSurface } from "../native/glass-surface";
import { ShowChatsButton } from "../thread/header/chat-route-header";
import { createInboxStyles } from "./inbox-styles";

/** The index route on a split window, where the chat list sits beside this pane. */
export function PickChatPane() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const contentBottomInset = useContentBottomInset();
  const styles = useThemedStyles(createInboxStyles);
  const { t } = useLingui();
  const { inboxShown } = useSplitView();
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
      {inboxShown ? null : (
        <GlassSurface
          shape="circle"
          style={[
            styles.headerCircle,
            { position: "absolute", top: insets.top + 8, left: 16 + insets.left },
          ]}
          fallbackStyle={styles.headerFill}
        >
          <ShowChatsButton />
        </GlassSurface>
      )}
      <Text style={styles.emptyPane}>{t`Pick a chat`}</Text>
    </View>
  );
}
