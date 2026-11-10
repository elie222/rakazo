import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useNavigation, usePreventRemove, useRouter } from "expo-router";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { Image, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GlassIconButton } from "../components/glass-icon-button";
import { NativeSymbol } from "../components/native-symbol";
import {
  cancelIncomingShare,
  getIncomingShare,
  subscribeIncomingShare,
} from "../lib/incoming-share";
import type { MobileBot } from "../lib/mobile-types";
import { useMobileTokens } from "../lib/native";
import { sharePreview } from "../lib/share-preview";
import { HomeSession } from "./index";

export default function ShareRoute() {
  const router = useRouter();
  const navigation = useNavigation();
  const share = useSyncExternalStore(subscribeIncomingShare, getIncomingShare);
  const leaving = useRef(false);
  const [guarded, setGuarded] = useState(true);
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const { t } = useLingui();
  const allowRemoval = usePreventRemove(guarded, ({ data, repeat }) => {
    const payload = data.action.payload;
    // Authentication temporarily replaces the picker; sign-in returns here with the share.
    if (payload && "name" in payload && payload.name === "sign-in") {
      leave();
      repeat();
      return;
    }
    close();
  });
  const leave = () => {
    leaving.current = true;
    setGuarded(false);
    allowRemoval();
  };
  const close = () => {
    leave();
    cancelIncomingShare();
    router.dismissTo("/");
  };
  const closeOnce = useEffectEvent(() => {
    if (!leaving.current) close();
  });

  useEffect(() => {
    if (!share) closeOnce();
  }, [share]);

  const open = (bot: Pick<MobileBot, "id" | "name">) => {
    // Removal must preserve the share for thread.tsx to claim it.
    if (!getIncomingShare()) return;
    leave();
    navigation.dispatch({
      type: "RESET",
      payload: {
        index: 1,
        routes: [{ name: "index" }, { name: "thread", params: { botId: bot.id, name: bot.name } }],
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
