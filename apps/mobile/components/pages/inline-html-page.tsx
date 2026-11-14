import { useLingui } from "@lingui/react/macro";
import { useNativeLinkConfirm } from "@rakazo/chat-ui/native";
import type { PageDetail } from "@rakazo/contracts";
import { pageLinkRequest } from "@rakazo/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { currentApiBase } from "../../lib/api";
import { useMobileTokens, useResolvedAppearance } from "../../lib/native";
import { pageActionAllowed, pageDocument, pageTapStart } from "../../lib/pages";
import { SandboxedHtmlPreview } from "../sandboxed-html-preview";

/** Before the page reports its height, the frame gets room to draw and measure. */
const UNMEASURED_HEIGHT = 360;
const MAX_PAGE_HEIGHT = 200_000;

/**
 * An HTML page in the chat at the page's own height. Its document runs in the sandboxed WebView,
 * which also passes up its height and the web links it asks the app to open.
 */
export function InlineHtmlPage({ detail }: { detail: PageDetail }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const theme = useResolvedAppearance();
  const openLink = useNativeLinkConfirm();
  const [document, setDocument] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(0);
  // The page acts for the person only right after they tapped it, never on load or on its own.
  const tapStart = useRef<ReturnType<typeof pageTapStart>>(null);
  const tappedAt = useRef<number | null>(null);
  useEffect(() => {
    let active = true;
    // A tap on the page before it reloads is not one on the new page.
    tappedAt.current = null;
    void pageDocument(currentApiBase(), detail.code, theme, t`This page couldn't be shown.`, {
      format: "html",
    }).then(
      (next) => {
        if (!active) return;
        setFailed(false);
        setDocument(next);
      },
      () => {
        if (!active) return;
        setDocument(null);
        setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [detail.code, theme, t]);
  const receive = useCallback(
    (data: string) => {
      let message: unknown;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (!message || typeof message !== "object") return;
      const { type, height: reported } = message as { type?: unknown; height?: unknown };
      if (type === "rakazo-page:height" && typeof reported === "number") {
        if (Number.isFinite(reported)) {
          setHeight(Math.min(Math.max(reported, 0), MAX_PAGE_HEIGHT));
        }
        return;
      }
      // Only the web and mail links any page may ask for, as in the full view.
      const url = pageLinkRequest(message);
      if (!url || !pageActionAllowed(tappedAt.current, Date.now())) return;
      // One tap, one action: anything else the page asks for after it waits for the next tap.
      tappedAt.current = null;
      openLink(url);
    },
    [openLink],
  );
  if (document === null) {
    return (
      <View style={[styles.failed, { backgroundColor: tokens.card }]}>
        {failed ? (
          <Text style={[styles.failedText, { color: tokens.mutedForeground }]}>
            {t`This page couldn't load`}
          </Text>
        ) : null}
      </View>
    );
  }
  return (
    <View
      style={{
        height: height || UNMEASURED_HEIGHT,
        overflow: "hidden",
        backgroundColor: tokens.card,
      }}
      onTouchStart={({ nativeEvent }) => {
        // A second finger makes it a pinch.
        const { pageX, pageY, touches } = nativeEvent;
        tapStart.current = touches.length === 1 ? { pageX, pageY } : null;
      }}
      onTouchMove={({ nativeEvent }) => {
        tapStart.current = pageTapStart(tapStart.current, nativeEvent);
      }}
      onTouchEnd={({ nativeEvent }) => {
        if (pageTapStart(tapStart.current, nativeEvent)) tappedAt.current = Date.now();
      }}
      onTouchCancel={() => {
        tapStart.current = null;
      }}
    >
      <SandboxedHtmlPreview
        html={document}
        background={tokens.card}
        scrollEnabled={false}
        onMessage={receive}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  failed: { minHeight: 240, alignItems: "center", justifyContent: "center" },
  failedText: { fontSize: 15, textAlign: "center", paddingHorizontal: 20 },
});
