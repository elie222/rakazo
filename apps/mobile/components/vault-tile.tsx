import { useLinkFavicon } from "@rakazo/chat-ui/native";
import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { Image, StyleSheet, View } from "react-native";
import { useMobileTokens } from "../lib/native";

/**
 * A vault item's tile: a login's site icon, fetched through the API, or else `children`, the
 * item's kind symbol.
 */
export function VaultTile({
  origin,
  style,
  children,
}: {
  /** A login's site; other kinds pass nothing. */
  origin?: string;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const tokens = useMobileTokens();
  const { icon, unusable } = useLinkFavicon(origin ?? "");
  return (
    <View style={[style, icon ? { backgroundColor: tokens.faviconPlate } : undefined]}>
      {icon ? (
        <Image
          accessibilityIgnoresInvertColors
          source={{ uri: icon }}
          style={styles.icon}
          resizeMode="contain"
          onLoad={(event) => {
            // A 1×1 image is a tracking pixel, not an icon.
            const { width, height } = event.nativeEvent.source;
            if (width <= 1 || height <= 1) unusable();
          }}
          onError={unusable}
        />
      ) : (
        children
      )}
    </View>
  );
}

const styles = StyleSheet.create({ icon: { width: "65%", height: "65%" } });
