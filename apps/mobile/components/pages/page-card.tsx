import { PageIcon } from "@rakazo/chat-ui/native";
import type { MessageBlock, PageDetail } from "@rakazo/contracts";
import { pageCardSuperseded } from "@rakazo/core";
import { useRouter } from "expo-router";
import { createContext, useContext, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { currentApiBase } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../../lib/native";
import { usePageCardDetail } from "../../lib/page-card-detail";
import { pageCardState, pageDocument, pagePreviewLayout } from "../../lib/pages";
import { SandboxedHtmlPreview } from "../sandboxed-html-preview";
import { InlineHtmlPage } from "./inline-html-page";

type PageBlock = Extract<MessageBlock, { kind: "page" }>;

/** The thread's newest card for each page, from `newestPageCards`, as web reads it. */
export const NewestPageCards = createContext<ReadonlyMap<string, string>>(new Map());

/**
 * The page's top, drawn live at desktop width and scaled into the card. A page or viewer that
 * could not load says so in its place; the card still opens the page, which can try again.
 */
function PagePreview({
  detail,
  failed,
  width,
}: {
  detail: PageDetail | null;
  failed: boolean;
  width: number;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const theme = useResolvedAppearance();
  const [document, setDocument] = useState<string | null>(null);
  const [documentFailed, setDocumentFailed] = useState(false);
  useEffect(() => {
    if (!detail) return;
    let active = true;
    void pageDocument(currentApiBase(), detail.code, theme, t("This page couldn't be shown."), {
      format: detail.format,
    })
      .then((html) => {
        if (!active) return;
        setDocument(html);
        setDocumentFailed(false);
      })
      .catch(() => {
        if (!active) return;
        setDocument(null);
        setDocumentFailed(true);
      });
    return () => {
      active = false;
    };
  }, [detail, theme, t]);
  const layout = pagePreviewLayout(width);
  // A newer version keeps the older preview while it builds, but never past a failure.
  const unavailable = failed || documentFailed;
  return (
    <View
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{ height: layout.height, overflow: "hidden", backgroundColor: tokens.card }}
    >
      {unavailable ? (
        <Text style={[styles.unavailable, { color: tokens.mutedForeground }]}>
          {t("This page couldn't load")}
        </Text>
      ) : null}
      {document && !unavailable && width > 0 ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: layout.frameWidth,
            height: layout.frameHeight,
            transformOrigin: "0 0",
            transform: [{ scale: layout.scale }],
          }}
        >
          <SandboxedHtmlPreview html={document} background={tokens.card} scrollEnabled={false} />
        </View>
      ) : null}
      <Svg style={styles.fade} width="100%" height={100}>
        <Defs>
          <LinearGradient id="page-fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={tokens.card} stopOpacity={0} />
            <Stop offset="1" stopColor={tokens.card} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height={100} fill="url(#page-fade)" />
      </Svg>
    </View>
  );
}

/** A page in the chat: its live top half and a footer naming it. Opens the latest version. */
export function PageCard({ block, messageId }: { block: PageBlock; messageId: string }) {
  const router = useRouter();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [width, setWidth] = useState(0);
  const detail = usePageCardDetail(block);
  const newest = useContext(NewestPageCards);
  const state = pageCardState(block, detail);
  const updatedBelow = state.status === "ready" && pageCardSuperseded(newest, messageId, block);
  const deleted = state.status === "deleted";
  const ready = state.status === "ready" ? state.detail : null;
  // An HTML page draws whole where it was saved; a superseded one keeps the compact preview.
  const inline = !deleted && !updatedBelow && ready?.format === "html";
  const open = () => router.push({ pathname: "/page", params: { pageId: block.pageId } });
  const footer = (
    <>
      <PageIcon colors={tokens} style={styles.icon} />
      <View style={styles.footerText}>
        <Text numberOfLines={1} style={[styles.title, { color: tokens.foreground }]}>
          {state.title}
        </Text>
        <Text numberOfLines={1} style={[styles.kind, { color: tokens.mutedForeground }]}>
          {deleted ? t("Deleted") : updatedBelow ? t("Updated below") : t("Page")}
        </Text>
      </View>
    </>
  );
  const surface = {
    backgroundColor: tokens.card,
    borderColor: `${tokens.foreground}1F`,
  };
  if (inline && ready) {
    // The page is interactive, so only its footer opens the full view; a Pressable around the
    // whole card would take the touches its own controls need.
    return (
      <View testID="page-card" style={[styles.card, surface]}>
        <InlineHtmlPage detail={ready} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Open {title}", { title: state.title })}
          onPress={open}
          style={({ pressed }) => [
            styles.footer,
            { borderTopColor: `${tokens.foreground}0A`, opacity: pressed ? 0.85 : 1 },
          ]}
        >
          {footer}
        </Pressable>
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Open {title}", { title: state.title })}
      testID="page-card"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      disabled={deleted}
      onPress={open}
      style={({ pressed }) => [styles.card, surface, { opacity: pressed ? 0.85 : 1 }]}
    >
      {deleted ? null : (
        <PagePreview detail={ready} failed={state.status === "failed"} width={width} />
      )}
      <View style={[styles.footer, { borderTopColor: `${tokens.foreground}0A` }]}>{footer}</View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: "100%",
    borderRadius: 24,
    borderWidth: 1,
    overflow: "hidden",
  },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0 },
  unavailable: { fontSize: 15, textAlign: "center", marginTop: 40, paddingHorizontal: 20 },
  footer: {
    height: 72,
    flexDirection: "row",
    alignItems: "center",
    gap: 14.5,
    paddingLeft: 15.5,
    paddingRight: 20,
    borderTopWidth: 1,
  },
  icon: { transform: [{ translateY: -3 }] },
  footerText: { flex: 1, minWidth: 0 },
  title: { fontSize: 17, lineHeight: 22 },
  kind: { fontSize: 15, lineHeight: 20, marginTop: 4 },
});
