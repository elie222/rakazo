import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { PageVisibility } from "@rakazo/contracts";
import { accountDisplay } from "@rakazo/core";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useReducer, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { NativeSymbol } from "../components/native-symbol";
import { PageLoadFailure } from "../components/pages/page-load-failure";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { useMobileTokens } from "../lib/native";
import {
  getLatestPage,
  pageShareLink,
  pageShareState,
  reducePageShare,
  savePageVisibility,
} from "../lib/pages";

type Loaded =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; title: string; owner: { name: string; image: string | null } };

/**
 * Who can open a page, in the platform's own sheet: the owner, Only you or Anyone with the link,
 * and once the link is on, Copy link, Share and Open in browser.
 */
export default function PageShareScreen() {
  const { pageId } = useLocalSearchParams<{ pageId: string }>();
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [copied, setCopied] = useState(false);
  const [linkProblem, setLinkProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, dispatch] = useReducer(
    reducePageShare,
    pageShareState({ visibility: "private", shareUrl: null }),
  );

  useEffect(() => {
    let active = true;
    setLoaded({ status: "loading" });
    void getLatestPage(pageId, { refresh: true, link: true }).then(
      (page) => {
        if (!active) return;
        dispatch({ type: "loaded", visibility: page.visibility, shareUrl: page.shareUrl });
        setLoaded({ status: "ready", title: page.title, owner: page.owner });
      },
      (error: unknown) => {
        if (active) setLoaded({ status: "error", error });
      },
    );
    return () => {
      active = false;
    };
  }, [pageId, attempt]);

  // Unknown (null) after a lost answer: either choice is sent, so the link can always be turned off.
  const choose = useCallback(
    (visibility: PageVisibility) => {
      if (state.pending !== null || visibility === state.visibility) return;
      dispatch({ type: "choose", visibility });
      // Turning the link on again issues a new one, which has not been copied.
      setCopied(false);
      void savePageVisibility(pageId, visibility, dispatch);
    },
    [pageId, state.pending, state.visibility],
  );

  if (loaded.status !== "ready") {
    return (
      <View style={styles.center}>
        {loaded.status === "loading" ? (
          <ActivityIndicator color={tokens.mutedForeground} />
        ) : (
          <PageLoadFailure
            error={loaded.error}
            fallback={t`Could not load this page.`}
            gone={t`This page isn't available`}
            onRetry={() => setAttempt((count) => count + 1)}
          />
        )}
      </View>
    );
  }
  const shown = state.pending ?? state.visibility;
  const link = pageShareLink(state);
  const owner = accountDisplay(loaded.owner, t`You`);
  const check = (value: PageVisibility) =>
    shown === value ? (
      <NativeSymbol ios="checkmark" android="checkmark" size={16} color={tokens.foreground} />
    ) : null;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Text numberOfLines={1} style={[styles.heading, { color: tokens.foreground }]}>
        {t`Share “${ph({ title: loaded.title })}”`}
      </Text>
      <SettingsGroup>
        <SettingsRow
          key="owner"
          title={owner.label}
          value={t`Owner`}
          leading={<Avatar owner={owner} />}
        />
      </SettingsGroup>
      <SettingsGroup label={t`Who can view`}>
        <SettingsRow
          key="private"
          accessibilityRole="radio"
          accessibilityState={{ checked: shown === "private" }}
          disabled={state.pending !== null}
          title={t`Only you`}
          leading={
            <NativeSymbol
              ios="lock"
              android="lock-closed-outline"
              size={18}
              color={tokens.foreground}
            />
          }
          trailing={check("private")}
          onPress={() => choose("private")}
        />
        <SettingsRow
          key="link"
          accessibilityRole="radio"
          accessibilityState={{ checked: shown === "link" }}
          disabled={state.pending !== null}
          title={t`Anyone with the link`}
          detail={t`No sign-in needed`}
          leading={
            <NativeSymbol ios="globe" android="globe-outline" size={18} color={tokens.foreground} />
          }
          trailing={check("link")}
          onPress={() => choose("link")}
        />
      </SettingsGroup>
      {state.error || linkProblem ? (
        <Text accessibilityRole="alert" style={[styles.error, { color: tokens.destructive }]}>
          {state.error ? t`Could not change who can view this page. Try again.` : linkProblem}
        </Text>
      ) : null}
      {link ? (
        <SettingsGroup>
          <SettingsRow
            key="copy"
            accessibilityRole="button"
            title={t`Copy link`}
            leading={
              <NativeSymbol
                ios={copied ? "checkmark" : "doc.on.doc"}
                android={copied ? "checkmark" : "copy-outline"}
                size={18}
                color={tokens.foreground}
              />
            }
            onPress={() => {
              setLinkProblem(null);
              void Clipboard.setStringAsync(link).then(
                () => setCopied(true),
                () => setLinkProblem(t`Could not copy the link.`),
              );
            }}
          />
          <SettingsRow
            key="share"
            accessibilityRole="button"
            title={t`Share`}
            leading={
              <NativeSymbol
                ios="square.and.arrow.up"
                android="share-outline"
                size={18}
                color={tokens.foreground}
              />
            }
            onPress={() => {
              setLinkProblem(null);
              void Share.share(Platform.OS === "ios" ? { url: link } : { message: link }).catch(
                () => setLinkProblem(t`Something went wrong. Try again.`),
              );
            }}
          />
          <SettingsRow
            key="open"
            accessibilityRole="button"
            title={t`Open in browser`}
            leading={
              <NativeSymbol
                ios="arrow.up.right"
                android="open-outline"
                size={18}
                color={tokens.foreground}
              />
            }
            onPress={() => {
              setLinkProblem(null);
              void WebBrowser.openBrowserAsync(link).catch(() =>
                setLinkProblem(t`Something went wrong. Try again.`),
              );
            }}
          />
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

function Avatar({ owner }: { owner: ReturnType<typeof accountDisplay> }) {
  const tokens = useMobileTokens();
  if (owner.image) {
    return (
      <Image source={{ uri: owner.image }} style={styles.avatar} accessibilityIgnoresInvertColors />
    );
  }
  return (
    <View style={[styles.avatar, { backgroundColor: tokens.border }]}>
      <Text style={[styles.initials, { color: tokens.foreground }]}>{owner.initial}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  content: { paddingTop: 16, paddingBottom: 24 },
  heading: {
    paddingHorizontal: 20,
    paddingBottom: 4,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "500",
    letterSpacing: -0.44,
  },
  error: { paddingHorizontal: 20, fontSize: 12, lineHeight: 16 },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  initials: { fontSize: 13, fontWeight: "500" },
});
