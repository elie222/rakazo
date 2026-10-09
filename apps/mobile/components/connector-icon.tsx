import { useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { SvgUri } from "react-native-svg";
import { native, useThemedStyles } from "../lib/native";

/** Use the catalog artwork, matching web, with a local fallback for missing logos. */
export function ConnectorIcon({
  name,
  logo,
  size = 36,
}: {
  name: string;
  logo?: string | null;
  size?: number;
}) {
  const styles = useThemedStyles(createStyles);
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  const uri = logo && logo !== failedLogo ? logo : null;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.frame, { width: size, height: size }]}
    >
      {uri ? (
        /\.svg(?:[?#]|$)/i.test(uri) ? (
          <SvgUri uri={uri} width={size - 8} height={size - 8} onError={() => setFailedLogo(uri)} />
        ) : (
          <Image
            source={{ uri }}
            resizeMode="contain"
            onError={() => setFailedLogo(uri)}
            style={{ width: size - 8, height: size - 8 }}
          />
        )
      ) : (
        <Text style={styles.letter}>{(name.trim()[0] || "?").toUpperCase()}</Text>
      )}
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    frame: {
      borderRadius: 10,
      backgroundColor: native.fillPressed,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    letter: { color: native.label, fontSize: 16, fontWeight: "600" },
  });
}
