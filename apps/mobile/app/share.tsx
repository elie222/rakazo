import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import { useIsFocused, useNavigation, usePreventRemove } from "expo-router";
import { StackActions } from "expo-router/react-navigation";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { Image, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GlassIconButton } from "../components/native/glass-icon-button";
import { NativeSymbol } from "../components/native/native-symbol";
import type { MobileBot } from "../lib/api/mobile-types";
import {
  cancelIncomingShare,
  chooseIncomingShareThread,
  getIncomingShare,
  subscribeIncomingShare,
} from "../lib/composer/incoming-share";
import { sharePreview } from "../lib/composer/share-preview";
import { useMobileTokens } from "../lib/native/native";
import { recordMobileShareAction, reportMobileError } from "../lib/platform/monitoring";
import { HomeSession } from "./index";

type LeaveAttempt = {
  action: "select" | "close" | "sign_in";
  navigate: () => void;
  releaseChoice?: () => void;
};

const TRANSITION_TIMEOUT_MS = 2_000;

export default function ShareRoute() {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const share = useSyncExternalStore(subscribeIncomingShare, getIncomingShare);
  const leaving = useRef(false);
  const [attempt, setAttempt] = useState<LeaveAttempt | null>(null);
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const { t } = useLingui();
  const allowRemoval = usePreventRemove(!attempt, ({ data, repeat }) => {
    const payload = data.action.payload;
    // Authentication temporarily replaces the picker; sign-in returns here with the share.
    if (payload && "name" in payload && payload.name === "sign-in") {
      leave({ action: "sign_in", navigate: repeat });
      return;
    }
    close();
  });
  const leave = (next: LeaveAttempt) => {
    if (leaving.current) return;
    leaving.current = true;
    setAttempt(next);
    allowRemoval();
  };
  // The prevention registry is React state too: same-tick navigation still sees the guard.
  useEffect(() => {
    if (!attempt) return;
    recordMobileShareAction(attempt.action);
    attempt.navigate();
  }, [attempt]);
  useTimeout(
    () => {
      // The picker can still be mounted when the destination already owns focus.
      if (!attempt || !navigation.isFocused()) return;
      attempt.releaseChoice?.();
      leaving.current = false;
      setAttempt(null);
      reportMobileError(new Error("Share picker navigation did not complete"), "mobile.share", {
        screen: "share",
        action: attempt.action,
      });
    },
    attempt && focused ? TRANSITION_TIMEOUT_MS : null,
    attempt,
  );
  const close = () => {
    if (leaving.current) return;
    cancelIncomingShare();
    leave({
      action: "close",
      navigate: () => {
        const stack = navigation.getState();
        if (!stack) return;
        // Dismiss just this picker. A screen underneath may have an unsaved draft.
        const action = stack.index > 0 ? StackActions.pop() : StackActions.replace("index");
        navigation.dispatch({ ...action, target: stack.key });
      },
    });
  };
  const closeOnce = useEffectEvent(close);

  useEffect(() => {
    if (!share && focused) closeOnce();
  }, [share, focused]);

  const open = (bot: Pick<MobileBot, "id" | "name">) => {
    if (leaving.current) return;
    const releaseChoice = chooseIncomingShareThread(bot.id);
    if (!releaseChoice) return;
    leave({
      action: "select",
      releaseChoice,
      navigate: () => {
        const stack = navigation.getState();
        if (!stack) return;
        const previous = stack.routes[stack.index - 1];
        const params = previous?.params;
        const action =
          previous?.name === "thread" && params && "botId" in params && params.botId === bot.id
            ? StackActions.pop()
            : StackActions.replace("thread", { botId: bot.id, name: bot.name });
        navigation.dispatch({ ...action, target: stack.key });
      },
    });
  };
  const preview = share ? sharePreview(share) : null;

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: tokens.background,
        paddingTop: insets.top + 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          marginHorizontal: 16,
          marginBottom: 12,
        }}
      >
        <GlassIconButton
          testID="share-close"
          accessibilityLabel={t`Close`}
          ios="xmark"
          android="close"
          size={44}
          color={tokens.foreground}
          fallbackStyle={{ backgroundColor: tokens.muted }}
          onPress={close}
        />
        <Text
          accessibilityRole="header"
          style={{ fontSize: 20, fontWeight: "600", color: tokens.foreground }}
        >
          {t`Share to`}
        </Text>
      </View>
      {preview ? (
        <View style={{ marginHorizontal: 20, paddingBottom: 12, gap: 8 }}>
          {preview.text ? (
            <Text numberOfLines={2} style={{ fontSize: 15, color: tokens.mutedForeground }}>
              {preview.text}
            </Text>
          ) : null}
          {preview.images.length ? (
            <View style={{ flexDirection: "row", gap: 8 }}>
              {preview.images.map((file, index) => (
                <Image
                  key={`${file.uri}:${index}`}
                  source={{ uri: file.uri }}
                  style={{ width: 48, height: 48, borderRadius: 8, backgroundColor: tokens.muted }}
                />
              ))}
              {preview.extraImages ? (
                <Text style={{ alignSelf: "center", color: tokens.mutedForeground }}>
                  +{preview.extraImages}
                </Text>
              ) : null}
            </View>
          ) : null}
          {preview.fileCount ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <NativeSymbol
                ios="doc"
                android="document-outline"
                size={20}
                color={tokens.mutedForeground}
              />
              <Text
                numberOfLines={1}
                style={{ flex: 1, fontSize: 15, color: tokens.mutedForeground }}
              >
                {preview.fileName ?? t`${ph({ count: preview.fileCount })} files`}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
      <HomeSession onShareSelect={open} />
    </View>
  );
}
