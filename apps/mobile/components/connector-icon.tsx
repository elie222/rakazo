import { useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { SvgUri } from "react-native-svg";
import { native, useThemedStyles } from "../lib/native";

/** Use the catalog artwork, matching web, with a local fallback for missing logos. */
export function ConnectorIcon({ name, logo }: { name: string; logo?: string | null }) {
  const styles = useThemedStyles(createStyles);
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  const uri = logo && logo !== failedLogo ? logo : null;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.frame}
    >
      {uri ? (
        /\.svg(?:[?#]|$)/i.test(uri) ? (
          <SvgUri uri={uri} width={28} height={28} onError={() => setFailedLogo(uri)} />
        ) : (
          <Image
            source={{ uri }}
            resizeMode="contain"
            onError={() => setFailedLogo(uri)}
            style={styles.image}
          />
        )
      ) : (
        <Text style={styles.letter}>{name[0]}</Text>
      )}
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    frame: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: native.fillPressed,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    image: { width: 28, height: 28 },
    letter: { color: native.label, fontSize: 16, fontWeight: "600" },
  });
}
