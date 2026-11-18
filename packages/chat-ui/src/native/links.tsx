import { useCallback, useContext } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { Alert, Image, Linking, View } from "react-native";
import {
  LinkFaviconsContext,
  markdownLinkNeedsPrompt,
  markdownLinkSite,
  sanitizeMarkdownUrl,
  useLinkFavicon,
} from "../markdown";
import {
  useMarkdownLinkAppOrigin,
  useMarkdownLinkCopy,
  useMarkdownLinkTrust,
} from "../markdown-link-prompt";
import { layout } from "./styles";

// Keeps the site icon on the line of the label's first word.
export const WORD_JOINER = "\u2060";
// First-strong isolate and its pop: a label's own direction characters cannot reorder the text
// around the link.
export const ISOLATE = "\u2068";
export const POP_ISOLATE = "\u2069";

async function openSafeLink(url: string) {
  const safeUrl = sanitizeMarkdownUrl(url);
  if (!safeUrl) return;
  if (await Linking.canOpenURL(safeUrl)) await Linking.openURL(safeUrl);
}

/** Opens a link the way a chat link opens: through the prompt unless it is in-app or trusted. */
export function useNativeLinkConfirm() {
  const appOrigin = useMarkdownLinkAppOrigin();
  const copy = useMarkdownLinkCopy();
  const { sites, trust } = useMarkdownLinkTrust();
  return useCallback(
    (raw: string) => {
      const url = sanitizeMarkdownUrl(raw);
      if (!url) return;
      if (!markdownLinkNeedsPrompt(url, appOrigin, sites)) {
        void openSafeLink(url);
        return;
      }
      const site = trust ? markdownLinkSite(url) : undefined;
      // Keep the actual host visible even when userinfo or the path is very long.
      Alert.alert(
        copy.title,
        `${new URL(url).host}\n\n${url}`,
        [
          { text: copy.cancel, style: "cancel" },
          ...(trust && site
            ? [
                {
                  text: copy.alwaysOpen(site),
                  onPress: () => {
                    void openSafeLink(url);
                    trust(url);
                  },
                },
              ]
            : []),
          {
            text: copy.open,
            onPress: () => {
              void openSafeLink(url);
            },
          },
        ],
        { cancelable: true },
      );
    },
    [appOrigin, copy, sites, trust],
  );
}

export function LinkFavicon({ href, plate }: { href: string; plate: StyleProp<ViewStyle> }) {
  const { icon, unusable } = useLinkFavicon(href);
  const globe = useContext(LinkFaviconsContext)?.globe;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={layout.linkMarker}
    >
      <View style={[layout.linkTile, icon ? plate : undefined]}>
        {icon ? (
          <Image
            source={{ uri: icon }}
            style={layout.linkIcon}
            resizeMode="contain"
            onLoad={(event) => {
              // A 1×1 image is a tracking pixel, not an icon.
              const { width, height } = event.nativeEvent.source;
              if (width <= 1 || height <= 1) unusable();
            }}
            onError={unusable}
          />
        ) : (
          globe
        )}
      </View>
    </View>
  );
}
