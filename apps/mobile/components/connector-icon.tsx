import type { ReactNode } from "react";
import { Component, useState } from "react";
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
  // Catalogs often serve SVG from extensionless URLs, which Image cannot decode,
  // so a failed raster load retries as SVG before falling back to the initial.
  const [failure, setFailure] = useState<{ logo: string; svgFailed: boolean } | null>(null);
  const failed = logo && failure?.logo === logo ? failure : null;
  const svg = Boolean(logo && (/\.svg(?:[?#]|$)/i.test(logo) || failed));
  const uri = logo && !failed?.svgFailed ? logo : null;
  const art = size - 8;
  const initial = <Text style={styles.letter}>{(name.trim()[0] || "?").toUpperCase()}</Text>;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.frame, { width: size, height: size }]}
    >
      {uri ? (
        svg ? (
          <ArtworkBoundary key={uri} onError={() => setFailure({ logo: uri, svgFailed: true })}>
            <SvgUri
              uri={uri}
              width={art}
              height={art}
              onError={() => setFailure({ logo: uri, svgFailed: true })}
              // SvgUri does not report XML parse errors, only renders this fallback.
              fallback={initial}
            />
          </ArtworkBoundary>
        ) : (
          <Image
            source={{ uri }}
            resizeMode="contain"
            onError={() => setFailure({ logo: uri, svgFailed: false })}
            style={{ width: art, height: art }}
          />
        )
      ) : (
        initial
      )}
    </View>
  );
}

/** Catalog SVGs are untrusted; one that react-native-svg cannot render, such as a
 * root `transform` its parser rejects, throws during render instead of calling onError. */
class ArtworkBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch() {
    this.props.onError();
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
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
