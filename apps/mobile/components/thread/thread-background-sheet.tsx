import * as ImagePicker from "expo-image-picker";
import { useRef, useState } from "react";
import {
  Alert,
  Image,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { mobileTokens } from "../../lib/appearance";
import {
  CHAT_BACKGROUND_DEFAULT_OPACITY,
  chatBackgroundOpacityFromRatio,
  deleteChatBackgroundFile,
  isChatBackgroundUrl,
  saveChatBackgroundFile,
  setChatBackground,
  setChatBackgroundOpacity,
  useChatBackground,
} from "../../lib/chat-background";
import {
  deleteHeroBackgroundFile,
  saveHeroBackgroundFile,
  setHeroBackground,
  setHeroBackgroundOpacity,
  useHeroBackground,
} from "../../lib/hero-background";
import { useI18n } from "../../lib/i18n";
import { NativeActionButton } from "../native-action-button";
import { NativeSheet, useNativeSheet } from "../native-sheet";
import { NativeSymbol } from "../native-symbol";

/**
 * The background settings: a local image, a subscribed image URL, or a
 * local video that plays muted on a loop, plus an opacity slider and a
 * restore-default button. Two independent sections share the one editor: the
 * chat background (behind the message list) and the title hero's background
 * (behind the big avatar and name). Each is stored per thread under its own
 * key, so setting one never touches the other.
 */
export function ThreadBackgroundSheet({
  visible,
  threadKey,
  heroVisible,
  onClose,
  onOpenCustomSettings,
}: {
  visible: boolean;
  threadKey: string | undefined;
  /** False where there is no title hero (groups): the hero section hides. */
  heroVisible?: boolean;
  onClose: () => void;
  /** Opens the interface settings; absent hides the entry row. */
  onOpenCustomSettings?: () => void;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const Sheet = useNativeSheet();
  const [section, setSection] = useState<"chat" | "hero">("chat");
  // Groups have no hero: the section is forced back to the chat background,
  // so a stale hero selection can never edit a hero that is not there.
  const activeSection = heroVisible === false ? "chat" : section;
  const chatBackground = useChatBackground(threadKey);
  const heroBackground = useHeroBackground(threadKey);
  const background = activeSection === "hero" ? heroBackground : chatBackground;
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sliderRef = useRef<View>(null);
  const [sliderWidth, setSliderWidth] = useState(0);
  const sliderWidthRef = useRef(0);
  sliderWidthRef.current = sliderWidth;
  // The slider's responder is created once, so it reads the thread key through a ref:
  // a stale first-render key would adjust another thread's background.
  const threadKeyRef = useRef(threadKey);
  threadKeyRef.current = threadKey;
  // Same for the section: the responder must write to the section that is
  // showing when the finger moves, not the one from the first render.
  const sectionRef = useRef(activeSection);
  sectionRef.current = activeSection;
  const slider = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        const key = threadKeyRef.current;
        if (sliderWidthRef.current > 0 && key) {
          const setOpacity =
            sectionRef.current === "hero" ? setHeroBackgroundOpacity : setChatBackgroundOpacity;
          setOpacity(
            key,
            chatBackgroundOpacityFromRatio(event.nativeEvent.locationX / sliderWidthRef.current),
          );
        }
      },
      onPanResponderMove: (event) => {
        const key = threadKeyRef.current;
        if (sliderWidthRef.current > 0 && key) {
          const setOpacity =
            sectionRef.current === "hero" ? setHeroBackgroundOpacity : setChatBackgroundOpacity;
          setOpacity(
            key,
            chatBackgroundOpacityFromRatio(event.nativeEvent.locationX / sliderWidthRef.current),
          );
        }
      },
    }),
  ).current;

  if (!visible || Sheet === undefined) return null;

  const opacity = background?.opacity ?? CHAT_BACKGROUND_DEFAULT_OPACITY;

  async function pickFile(kind: "image" | "video") {
    if (busy || !threadKey) return;
    setBusy(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: kind === "image" ? ["images"] : ["videos"],
      });
      const asset = result.assets?.[0];
      if (result.canceled || !asset) return;
      if (activeSection === "hero") {
        const saved = await saveHeroBackgroundFile(
          threadKey,
          asset.uri,
          asset.fileName ?? "background",
          kind,
        );
        setHeroBackground(threadKey, { kind, ...saved, opacity });
      } else {
        const saved = await saveChatBackgroundFile(
          threadKey,
          asset.uri,
          asset.fileName ?? "background",
          kind,
        );
        setChatBackground(threadKey, { kind, ...saved, opacity });
      }
      // The "Current background" line above updates live; that is the confirmation.
    } catch {
      Alert.alert(t("Could not load that file"), t("Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function subscribeUrl() {
    if (!threadKey) return;
    const trimmed = url.trim();
    if (!isChatBackgroundUrl(trimmed)) {
      setUrlError(
        trimmed
          ? t("This image URL could not be loaded. Try a direct image link.")
          : t("Enter an image URL to subscribe"),
      );
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const ok = await Image.prefetch(trimmed);
      if (!ok) throw new Error("prefetch failed");
      if (activeSection === "hero") {
        setHeroBackground(threadKey, { kind: "url", uri: trimmed, opacity });
      } else {
        setChatBackground(threadKey, { kind: "url", uri: trimmed, opacity });
      }
      setUrl("");
      setUrlError(null);
    } catch {
      setUrlError(t("This image URL could not be loaded. Try a direct image link."));
    } finally {
      setBusy(false);
    }
  }

  const currentLabel = !background
    ? t("Default")
    : background.kind === "image"
      ? t("Local image")
      : background.kind === "video"
        ? t("Video")
        : t("Subscribed: {url}", { url: background.uri });

  const content = (
    <View style={{ backgroundColor: tokens.card, paddingBottom: 12 }}>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingHorizontal: 20,
          paddingTop: Sheet ? 4 : 12,
          paddingBottom: 8,
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 17, fontWeight: "600" }}>
          {activeSection === "hero" ? t("Hero background") : t("Chat background")}
        </Text>
        <NativeActionButton label={t("Cancel")} prominence="plain" onPress={onClose} />
      </View>
      {heroVisible === false ? null : (
        <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 20, paddingBottom: 12 }}>
          {(["chat", "hero"] as const).map((option) => (
            <Pressable
              key={option}
              accessibilityRole="button"
              accessibilityLabel={option === "hero" ? t("Hero background") : t("Chat background")}
              onPress={() => {
                setSection(option);
                setUrl("");
                setUrlError(null);
              }}
              style={{
                flex: 1,
                alignItems: "center",
                paddingVertical: 8,
                borderRadius: 10,
                backgroundColor: activeSection === option ? tokens.accent : tokens.muted,
              }}
            >
              <Text
                style={{
                  color: activeSection === option ? tokens.link : tokens.foreground,
                  fontSize: 15,
                  fontWeight: activeSection === option ? "600" : "400",
                }}
              >
                {option === "hero" ? t("Hero background") : t("Chat background")}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      <Text
        style={{
          color: tokens.mutedForeground,
          fontSize: 13,
          paddingHorizontal: 20,
          paddingBottom: 12,
        }}
      >
        {t("Current background: {name}", { name: currentLabel })}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Choose an image")}
        disabled={busy}
        onPress={() => void pickFile("image")}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: 20,
          paddingVertical: 12,
          ...(pressed ? { backgroundColor: tokens.muted } : null),
        })}
      >
        <NativeSymbol ios="photo" android="image-outline" size={20} color={tokens.link} />
        <Text style={{ color: tokens.foreground, fontSize: 16 }}>{t("Local image")}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Choose a video")}
        disabled={busy}
        onPress={() => void pickFile("video")}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: 20,
          paddingVertical: 12,
          ...(pressed ? { backgroundColor: tokens.muted } : null),
        })}
      >
        <NativeSymbol ios="video" android="videocam-outline" size={20} color={tokens.link} />
        <Text style={{ color: tokens.foreground, fontSize: 16 }}>{t("Local video")}</Text>
      </Pressable>
      <View style={{ paddingHorizontal: 20, paddingTop: 8, gap: 8 }}>
        <Text style={{ color: tokens.foreground, fontSize: 16 }}>{t("URL subscription")}</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TextInput
            value={url}
            onChangeText={(next) => {
              setUrl(next);
              setUrlError(null);
            }}
            placeholder={t("Paste an image URL")}
            placeholderTextColor={tokens.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={{
              flex: 1,
              borderWidth: 1,
              borderColor: tokens.border,
              borderRadius: 10,
              paddingHorizontal: 12,
              paddingVertical: 10,
              color: tokens.foreground,
              fontSize: 15,
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Subscribe")}
            disabled={busy}
            onPress={() => void subscribeUrl()}
            style={{
              borderRadius: 10,
              backgroundColor: tokens.accent,
              paddingHorizontal: 16,
              justifyContent: "center",
            }}
          >
            <Text style={{ color: tokens.link, fontSize: 15, fontWeight: "600" }}>
              {t("Subscribe")}
            </Text>
          </Pressable>
        </View>
        {urlError ? (
          <Text accessibilityRole="alert" style={{ color: tokens.destructive, fontSize: 13 }}>
            {urlError}
          </Text>
        ) : null}
      </View>
      <View style={{ paddingHorizontal: 20, paddingTop: 20, gap: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ color: tokens.foreground, fontSize: 16 }}>{t("Background opacity")}</Text>
          <Text style={{ color: tokens.mutedForeground, fontSize: 15 }}>{opacity}%</Text>
        </View>
        <View
          ref={sliderRef}
          onLayout={(event) => setSliderWidth(event.nativeEvent.layout.width)}
          {...slider.panHandlers}
          style={{ height: 28, justifyContent: "center" }}
        >
          <View style={{ height: 4, borderRadius: 2, backgroundColor: tokens.border }} />
          <View
            style={{
              position: "absolute",
              left: 0,
              height: 4,
              borderRadius: 2,
              width: `${opacity}%`,
              backgroundColor: tokens.link,
            }}
          />
          <View
            style={{
              position: "absolute",
              left: `${opacity}%`,
              marginLeft: -10,
              width: 20,
              height: 20,
              borderRadius: 10,
              backgroundColor: tokens.card,
              borderWidth: 1,
              borderColor: tokens.border,
            }}
          />
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Restore default background")}
        disabled={!background || busy}
        onPress={() => {
          if (!threadKey) return;
          // Clearing the background also removes its local file, so a restored
          // default leaves nothing behind in documents.
          if (background && (background.kind === "image" || background.kind === "video")) {
            if (activeSection === "hero") {
              void deleteHeroBackgroundFile(background.uri);
            } else {
              void deleteChatBackgroundFile(background.uri);
            }
          }
          if (activeSection === "hero") {
            setHeroBackground(threadKey, null);
          } else {
            setChatBackground(threadKey, null);
          }
        }}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: 20,
          paddingVertical: 12,
          marginTop: 8,
          ...(pressed ? { backgroundColor: tokens.muted } : null),
        })}
      >
        <NativeSymbol
          ios="arrow.uturn.backward"
          android="refresh-outline"
          size={20}
          color={tokens.link}
        />
        <Text style={{ color: tokens.foreground, fontSize: 16 }}>
          {t("Restore default background")}
        </Text>
      </Pressable>
      {onOpenCustomSettings ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Customize interface")}
          onPress={onOpenCustomSettings}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingHorizontal: 20,
            paddingVertical: 12,
            marginTop: 8,
            ...(pressed ? { backgroundColor: tokens.muted } : null),
          })}
        >
          <NativeSymbol
            ios="slider.horizontal.3"
            android="options-outline"
            size={20}
            color={tokens.link}
          />
          <Text style={{ color: tokens.foreground, fontSize: 16 }}>{t("Customize interface")}</Text>
          <View style={{ flex: 1 }} />
          <NativeSymbol
            ios="chevron.right"
            android="chevron-forward-outline"
            size={16}
            color={tokens.mutedForeground}
          />
        </Pressable>
      ) : null}
    </View>
  );

  if (Sheet) {
    return (
      <NativeSheet
        Sheet={Sheet}
        onClose={onClose}
        label={activeSection === "hero" ? t("Hero background") : t("Chat background")}
      >
        {content}
      </NativeSheet>
    );
  }
  if (Platform.OS === "ios") {
    return (
      <Modal visible animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
        {content}
      </Modal>
    );
  }
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.4)" }}>
        {content}
      </View>
    </Modal>
  );
}
