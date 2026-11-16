import type { ReactElement, ReactNode } from "react";
import { Component, useEffect, useEffectEvent, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { fetchText, SvgXml } from "react-native-svg";
import { catalogSvgXml } from "../../lib/integrations/catalog-svg";
import { native, useThemedStyles } from "../../lib/native/native";

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
            <CatalogSvg
              uri={uri}
              width={art}
              height={art}
              onError={() => setFailure({ logo: uri, svgFailed: true })}
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

/** Read artwork before handing CSS lengths to the native renderer. */
function CatalogSvg({
  uri,
  onError,
  fallback,
  ...size
}: {
  uri: string;
  onError: () => void;
  fallback: ReactElement;
  width: number;
  height: number;
}) {
  const [xml, setXml] = useState<string | null>(null);
  const fail = useEffectEvent(onError);
  useEffect(() => {
    let current = true;
    void fetchText(uri).then(
      (value) => {
        if (current) setXml(value === null ? null : catalogSvgXml(value));
      },
      () => {
        if (current) fail();
      },
    );
    return () => {
      current = false;
    };
  }, [uri]);
  return <SvgXml xml={xml} {...size} onError={onError} fallback={fallback} />;
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
