import { useNativeLinkConfirm } from "@rakazo/chat-ui/native";
import type { PageDetail } from "@rakazo/contracts";
import { pageCopyRequest, pageCopyResult, pageLinkRequest, pageReplyText } from "@rakazo/core";
import { webTokensForAppearance } from "@rakazo/ui-tokens";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeActionButton } from "../components/native-action-button";
import { PageLoadFailure } from "../components/pages/page-load-failure";
import { SandboxedHtmlPreview } from "../components/sandboxed-html-preview";
import { currentApiBase } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { HEADER_CONTROL_SIZE } from "../lib/native-controls";
import {
  getLatestPage,
  offerPageReply,
  pageActionAllowed,
  pageChat,
  pageDocument,
  pageMessage,
  pageTapStart,
} from "../lib/pages";

type Loaded =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; page: PageDetail; document: string };

/** A page full screen: the page itself under a close button and a share button. */
export default function PageScreen() {
  const { pageId } = useLocalSearchParams<{ pageId: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const theme = useResolvedAppearance();
  // Pages paint the web palette's background; the screen around them matches it.
  const pageBackground = webTokensForAppearance(theme).background;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // iOS keeps the native glass button as it is; Android's bordered button becomes a card circle.
  const round =
    Platform.OS === "ios" ? undefined : [styles.round, { backgroundColor: tokens.card }];

  useEffect(() => {
    let active = true;
    // A tap on the page before it reloads is not one on the new page.
    tappedAt.current = null;
    setLoaded({ status: "loading" });
    void getLatestPage(pageId, { refresh: true })
      .then(async (page) => {
        const document = await pageDocument(
          currentApiBase(),
          page.code,
          theme,
          t("This page couldn't be shown."),
          { reply: pageChat(page) !== null, format: page.format },
        );
        if (!active) return;
        setLoaded({ status: "ready", page, document });
      })
      .catch((error: unknown) => {
        if (active) setLoaded({ status: "error", error });
      });
    return () => {
      active = false;
    };
  }, [pageId, theme, t, attempt]);

  const openLink = useNativeLinkConfirm();
  // The app sees every touch on the WebView too (React Native's root handler, on iOS and Android),
  // and the page can't fake one.
  const tapStart = useRef<ReturnType<typeof pageTapStart>>(null);
  const tappedAt = useRef<number | null>(null);
  const receive = useCallback(
    (data: string, answer: (message: object) => void) => {
      if (!pageActionAllowed(tappedAt.current, Date.now())) return;
      const message = pageMessage(data) as { type?: unknown; text?: unknown } | null;
      const reply = message?.type === "rakazo-page:reply" ? pageReplyText(message.text) : null;
      const page = loaded.status === "ready" ? loaded.page : null;
      const chat = reply && page ? pageChat(page) : null;
      const url = pageLinkRequest(message);
      const copy = pageCopyRequest(message);
      if (!(reply && page && chat) && !url && !copy) return;
      // One tap, one action: anything else the page asks for after it waits for the next tap.
      tappedAt.current = null;
      if (reply && page && chat) {
        // Into the page's chat, as on the web: back to it when it is right under the page.
        offerPageReply(chat.threadKey, { text: reply, page: { id: page.id, title: page.title } });
        const state = navigation.getState();
        const below = state?.routes[state.index - 1];
        const params = below?.params as Record<string, unknown> | undefined;
        if (`/${below?.name}` === chat.pathname && params?.[chat.key] === chat.threadKey) {
          router.back();
        } else {
          router.replace({ pathname: chat.pathname, params: { [chat.key]: chat.threadKey } });
        }
      } else if (url) {
        openLink(url);
      } else if (copy) {
        void Clipboard.setStringAsync(copy.text)
          .catch(() => false)
          .then((ok) => answer(pageCopyResult(copy.id, ok !== false)));
      }
    },
    [openLink, loaded, navigation, router],
  );

  return (
    <View style={[styles.screen, { backgroundColor: pageBackground }]}>
      {loaded.status === "ready" ? (
        // The page starts below the round buttons; its own top padding keeps the title clear.
        <View
          style={[styles.screen, { paddingTop: insets.top + HEADER_CONTROL_SIZE }]}
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
            html={loaded.document}
            background={pageBackground}
            onMessage={receive}
          />
        </View>
      ) : loaded.status === "error" ? (
        <View style={styles.center}>
          <PageLoadFailure
            error={loaded.error}
            fallback={t("Could not load this page.")}
            gone={t("This page isn't available")}
            onRetry={() => setAttempt((count) => count + 1)}
          />
        </View>
      ) : (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.mutedForeground} />
        </View>
      )}
      <View pointerEvents="box-none" style={[styles.controls, { top: insets.top + 6 }]}>
        <NativeActionButton
          accessibilityLabel={t("Close")}
          icon={{ ios: "xmark", android: "close", size: 20 }}
          prominence="secondary"
          style={round}
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        />
        {loaded.status === "ready" ? (
          <NativeActionButton
            accessibilityLabel={t("Share")}
            icon={{ ios: "square.and.arrow.up", android: "share-outline", size: 20 }}
            prominence="secondary"
            style={round}
            onPress={() => router.push({ pathname: "/page-share", params: { pageId } })}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  controls: {
    position: "absolute",
    left: 12,
    right: 12,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  round: {
    width: HEADER_CONTROL_SIZE,
    minHeight: HEADER_CONTROL_SIZE,
    borderRadius: HEADER_CONTROL_SIZE / 2,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
});
