import * as DocumentPicker from "expo-document-picker";
import { useRef, useState } from "react";
import {
  Alert,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { mobileTokens } from "../../lib/appearance";
import type {
  CustomFontSlot,
  CustomMessageBackgrounds,
  MessageActionId,
} from "../../lib/custom-settings";
import {
  CUSTOM_SETTINGS_CHAT_SIZE_MAX,
  CUSTOM_SETTINGS_CHAT_SIZE_MIN,
  CUSTOM_SETTINGS_CHIPS_CARD_WIDTH_MAX,
  CUSTOM_SETTINGS_CHIPS_CARD_WIDTH_MIN,
  CUSTOM_SETTINGS_CHIPS_ROW_WIDTH_MAX,
  CUSTOM_SETTINGS_CHIPS_ROW_WIDTH_MIN,
  CUSTOM_SETTINGS_ERROR_COLOR_DEFAULT,
  CUSTOM_SETTINGS_ERROR_SIZE_MAX,
  CUSTOM_SETTINGS_ERROR_SIZE_MIN,
  CUSTOM_SETTINGS_HERO_HEIGHT_MAX,
  CUSTOM_SETTINGS_HERO_HEIGHT_MIN,
  CUSTOM_SETTINGS_TITLE_SIZE_MAX,
  CUSTOM_SETTINGS_TITLE_SIZE_MIN,
  customErrorTextStyle,
  customFontFamily,
  customTitleTextStyle,
  DEFAULT_MESSAGE_ACTION_ORDER,
  heroBackgroundHeightFor,
  importCustomFont,
  removeImportedFont,
  scaledLineHeight,
  setCustomSettings,
  setHeroBackgroundHeight,
  useCustomSettings,
} from "../../lib/custom-settings";
import { useI18n } from "../../lib/i18n";
import { native } from "../../lib/native";
import { NativeActionButton } from "../native-action-button";
import { NativeSheet, useNativeSheet } from "../native-sheet";
import { NativeSymbol } from "../native-symbol";

const TITLE_SWATCHES = ["#111111", "#2f6bff", "#1f7a3d", "#8a5a2b"];
const CHAT_SWATCHES = ["#111111", "#5b6470", "#2f6bff", "#1f7a3d"];
const ERROR_SWATCHES = [
  CUSTOM_SETTINGS_ERROR_COLOR_DEFAULT,
  "#c92a2a",
  "#e8590c",
  "#8a5a2b",
  "#111111",
];

/** Light tints that read as message bubbles; any hex works through the input below. */
const MESSAGE_BACKGROUND_SWATCHES = ["#e8efff", "#e6f4ea", "#fff3bf", "#fde8e8", "#e5e7eb"];

const ACTION_LABEL_KEYS: Record<MessageActionId, string> = {
  copy: "Copy",
  speak: "Speak message",
  share: "Share",
  favorite: "Favorite",
  regenerate: "Regenerate",
};

function snapSliderValue(min: number, max: number, step: number, ratio: number): number {
  const raw = min + Math.min(1, Math.max(0, ratio)) * (max - min);
  return Math.min(max, Math.max(min, Math.round(raw / step) * step));
}

/** A slider in the background sheet's style: drag anywhere on the track to set the value. */
function SettingSlider({
  value,
  min,
  max,
  step,
  accessibilityLabel,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  accessibilityLabel: string;
  onChange: (value: number) => void;
}) {
  const tokens = mobileTokens();
  const [sliderWidth, setSliderWidth] = useState(0);
  const widthRef = useRef(0);
  widthRef.current = sliderWidth;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const boundsRef = useRef({ min, max, step });
  boundsRef.current = { min, max, step };
  const slider = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        if (widthRef.current > 0) {
          const { min: lo, max: hi, step: by } = boundsRef.current;
          onChangeRef.current(
            snapSliderValue(lo, hi, by, event.nativeEvent.locationX / widthRef.current),
          );
        }
      },
      onPanResponderMove: (event) => {
        if (widthRef.current > 0) {
          const { min: lo, max: hi, step: by } = boundsRef.current;
          onChangeRef.current(
            snapSliderValue(lo, hi, by, event.nativeEvent.locationX / widthRef.current),
          );
        }
      },
    }),
  ).current;
  const ratio = max > min ? (value - min) / (max - min) : 0;
  return (
    <View
      onLayout={(event) => setSliderWidth(event.nativeEvent.layout.width)}
      {...slider.panHandlers}
      style={{ height: 28, justifyContent: "center" }}
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min, max, now: value }}
    >
      <View style={{ height: 4, borderRadius: 2, backgroundColor: tokens.border }} />
      <View
        style={{
          position: "absolute",
          left: 0,
          height: 4,
          borderRadius: 2,
          width: `${ratio * 100}%`,
          backgroundColor: tokens.link,
        }}
      />
      <View
        style={{
          position: "absolute",
          left: `${ratio * 100}%`,
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
  );
}

function SectionTitle({ children }: { children: string }) {
  const tokens = mobileTokens();
  return (
    <Text
      style={{
        color: tokens.mutedForeground,
        fontSize: 13,
        fontWeight: "600",
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 8,
      }}
    >
      {children}
    </Text>
  );
}

function RowLabel({ label, value }: { label: string; value: string }) {
  const tokens = mobileTokens();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 20 }}>
      <Text style={{ color: tokens.foreground, fontSize: 16 }}>{label}</Text>
      <Text style={{ color: tokens.mutedForeground, fontSize: 15 }}>{value}</Text>
    </View>
  );
}

function ColorSwatches({
  colors,
  selected,
  allowFollowTheme,
  onSelect,
  label,
}: {
  colors: readonly string[];
  selected: string | null;
  allowFollowTheme: boolean;
  onSelect: (color: string | null) => void;
  label: string;
}) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 20,
        paddingTop: 8,
        flexWrap: "wrap",
      }}
    >
      {allowFollowTheme ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Follow theme")}
          accessibilityState={{ selected: selected === null }}
          onPress={() => onSelect(null)}
          style={{
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: selected === null ? tokens.link : tokens.border,
            backgroundColor: selected === null ? tokens.accent : "transparent",
          }}
        >
          <Text
            style={{
              color: selected === null ? tokens.link : tokens.foreground,
              fontSize: 13,
            }}
          >
            {t("Follow theme")}
          </Text>
        </Pressable>
      ) : null}
      {colors.map((color) => (
        <Pressable
          key={color}
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${color}`}
          accessibilityState={{ selected: selected === color }}
          onPress={() => onSelect(color)}
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            backgroundColor: color,
            borderWidth: selected === color ? 2 : 1,
            borderColor: selected === color ? tokens.link : tokens.border,
          }}
        />
      ))}
    </View>
  );
}

function CustomColorInput({
  current,
  onApply,
}: {
  current: string | null;
  onApply: (color: string) => void;
}) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const [text, setText] = useState(current ?? "");
  return (
    <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 20, paddingTop: 8 }}>
      <TextInput
        value={text}
        onChangeText={setText}
        onSubmitEditing={() => {
          const trimmed = text.trim();
          if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) onApply(trimmed.toLowerCase());
        }}
        placeholder={t("Custom color")}
        placeholderTextColor={tokens.mutedForeground}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={7}
        style={{
          flex: 1,
          borderWidth: 1,
          borderColor: tokens.border,
          borderRadius: 10,
          paddingHorizontal: 12,
          paddingVertical: 8,
          color: tokens.foreground,
          fontSize: 15,
        }}
      />
    </View>
  );
}

/**
 * The interface settings: this thread's hero background height, the quick row's
 * width and card size, the three font slots with their colours and imported
 * fonts, the three message backgrounds, and the AI reply action row's order and
 * hidden tiles. Every change writes to the settings at once, so the chat behind
 * the sheet follows live.
 */
export function ThreadCustomSettingsSheet({
  visible,
  userId,
  threadKey,
  heroVisible,
  onClose,
}: {
  visible: boolean;
  userId: string;
  threadKey: string | undefined;
  /** False where there is no title hero (groups): the hero section hides. */
  heroVisible?: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const Sheet = useNativeSheet();
  const settings = useCustomSettings(userId);
  const [busy, setBusy] = useState(false);

  if (!visible || Sheet === undefined) return null;

  const heroHeight = heroBackgroundHeightFor(settings, threadKey);
  const fontFamily = customFontFamily(settings);

  function setFontSlot(slot: "title" | "chat" | "error", patch: Partial<CustomFontSlot>) {
    const next = { ...settings.font[slot], ...patch };
    if (slot === "title") setCustomSettings(userId, { font: { title: next } });
    else if (slot === "chat") setCustomSettings(userId, { font: { chat: next } });
    else setCustomSettings(userId, { font: { error: next } });
  }

  function setMessageBackground(slot: keyof CustomMessageBackgrounds, color: string | null) {
    setCustomSettings(userId, { messageBackgrounds: { [slot]: color } });
  }

  async function pickFont() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        copyToCacheDirectory: true,
      });
      const asset = result.assets?.[0];
      if (result.canceled || !asset) return;
      const imported = await importCustomFont(userId, asset.uri, asset.name);
      if (!imported) {
        Alert.alert(t("Could not load that font"), t("Try a .ttf or .otf font file."));
      }
    } catch {
      Alert.alert(t("Could not load that font"), t("Try a .ttf or .otf font file."));
    } finally {
      setBusy(false);
    }
  }

  function moveAction(id: MessageActionId, direction: -1 | 1) {
    const order = [...settings.messageActions.order];
    const index = order.indexOf(id);
    const target = index + direction;
    const current = order[index];
    const neighbor = order[target];
    if (index < 0 || target < 0 || target >= order.length || !current || !neighbor) return;
    order[index] = neighbor;
    order[target] = current;
    setCustomSettings(userId, { messageActions: { order } });
  }

  function toggleAction(id: MessageActionId) {
    const hidden = settings.messageActions.hidden.includes(id)
      ? settings.messageActions.hidden.filter((item) => item !== id)
      : [...settings.messageActions.hidden, id];
    setCustomSettings(userId, { messageActions: { hidden } });
  }

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
          {t("Customize interface")}
        </Text>
        <NativeActionButton label={t("Cancel")} prominence="plain" onPress={onClose} />
      </View>

      {heroVisible === false ? null : (
        <>
          <SectionTitle>{t("Hero background")}</SectionTitle>
          <RowLabel label={t("Hero background height")} value={`${heroHeight}%`} />
          <View style={{ paddingHorizontal: 20, paddingTop: 4 }}>
            <SettingSlider
              value={heroHeight}
              min={CUSTOM_SETTINGS_HERO_HEIGHT_MIN}
              max={CUSTOM_SETTINGS_HERO_HEIGHT_MAX}
              step={5}
              accessibilityLabel={t("Hero background height")}
              onChange={(value) => {
                if (threadKey) setHeroBackgroundHeight(userId, threadKey, value);
              }}
            />
          </View>
        </>
      )}

      <SectionTitle>{t("Input row")}</SectionTitle>
      <RowLabel label={t("Row width")} value={`${settings.chipsRowWidthPct}%`} />
      <View style={{ paddingHorizontal: 20, paddingTop: 4 }}>
        <SettingSlider
          value={settings.chipsRowWidthPct}
          min={CUSTOM_SETTINGS_CHIPS_ROW_WIDTH_MIN}
          max={CUSTOM_SETTINGS_CHIPS_ROW_WIDTH_MAX}
          step={5}
          accessibilityLabel={t("Row width")}
          onChange={(value) => setCustomSettings(userId, { chipsRowWidthPct: value })}
        />
      </View>
      <View style={{ paddingTop: 8 }}>
        <RowLabel label={t("Card width")} value={`${settings.chipsCardWidth}px`} />
        <View style={{ paddingHorizontal: 20, paddingTop: 4 }}>
          <SettingSlider
            value={settings.chipsCardWidth}
            min={CUSTOM_SETTINGS_CHIPS_CARD_WIDTH_MIN}
            max={CUSTOM_SETTINGS_CHIPS_CARD_WIDTH_MAX}
            step={2}
            accessibilityLabel={t("Card width")}
            onChange={(value) => setCustomSettings(userId, { chipsCardWidth: value })}
          />
        </View>
      </View>

      <SectionTitle>{t("Font")}</SectionTitle>
      <Text
        style={{
          color: tokens.foreground,
          fontSize: 16,
          paddingHorizontal: 20,
          paddingBottom: 4,
        }}
      >
        {t("Font family")}
      </Text>
      <View style={{ paddingHorizontal: 20, paddingTop: 8, gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: settings.font.family === "system" }}
          onPress={() => setCustomSettings(userId, { font: { family: "system" } })}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingVertical: 8,
            paddingHorizontal: 12,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: settings.font.family === "system" ? tokens.link : tokens.border,
            backgroundColor: settings.font.family === "system" ? tokens.accent : "transparent",
          }}
        >
          <Text style={{ color: tokens.foreground, fontSize: 15, flex: 1 }}>
            {t("System default")}
          </Text>
          {settings.font.family === "system" ? (
            <NativeSymbol
              ios="checkmark"
              android="checkmark-outline"
              size={16}
              color={tokens.link}
            />
          ) : null}
        </Pressable>
        {settings.font.imported.map((entry) => (
          <View
            key={entry.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              paddingVertical: 8,
              paddingHorizontal: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: settings.font.family === entry.family ? tokens.link : tokens.border,
              backgroundColor:
                settings.font.family === entry.family ? tokens.accent : "transparent",
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: settings.font.family === entry.family }}
              onPress={() => setCustomSettings(userId, { font: { family: entry.family } })}
              style={{ flex: 1 }}
            >
              <Text style={{ color: tokens.foreground, fontSize: 15 }}>{entry.family}</Text>
              <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>{entry.fileName}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Remove {name}", { name: entry.family })}
              onPress={() => removeImportedFont(userId, entry.id)}
              style={{ padding: 6 }}
            >
              <NativeSymbol
                ios="trash"
                android="trash-outline"
                size={18}
                color={tokens.destructive}
              />
            </Pressable>
          </View>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Import font")}
          disabled={busy}
          onPress={() => void pickFont()}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingVertical: 10,
            ...(pressed ? { opacity: 0.6 } : null),
          })}
        >
          <NativeSymbol
            ios="square.and.arrow.down"
            android="download-outline"
            size={20}
            color={tokens.link}
          />
          <Text style={{ color: tokens.foreground, fontSize: 16 }}>{t("Import font")}</Text>
        </Pressable>
      </View>

      <View style={{ paddingTop: 12 }}>
        <RowLabel label={t("Title")} value={`${settings.font.title.size}px`} />
        <View style={{ paddingHorizontal: 20, paddingTop: 4 }}>
          <SettingSlider
            value={settings.font.title.size}
            min={CUSTOM_SETTINGS_TITLE_SIZE_MIN}
            max={CUSTOM_SETTINGS_TITLE_SIZE_MAX}
            step={1}
            accessibilityLabel={t("Title")}
            onChange={(value) => setFontSlot("title", { size: value })}
          />
        </View>
        <ColorSwatches
          colors={TITLE_SWATCHES}
          selected={settings.font.title.color}
          allowFollowTheme
          onSelect={(color) => setFontSlot("title", { color })}
          label={t("Title")}
        />
        <CustomColorInput
          key={`title-${settings.font.title.color ?? "theme"}`}
          current={settings.font.title.color}
          onApply={(color) => setFontSlot("title", { color })}
        />
        <Text
          style={[
            { color: tokens.foreground, paddingHorizontal: 20, paddingTop: 12 },
            customTitleTextStyle(settings),
          ]}
        >
          {t("Hello, I'm Rakazo")}
        </Text>
      </View>

      <View style={{ paddingTop: 12 }}>
        <RowLabel label={t("Conversation")} value={`${settings.font.chat.size}px`} />
        <View style={{ paddingHorizontal: 20, paddingTop: 4 }}>
          <SettingSlider
            value={settings.font.chat.size}
            min={CUSTOM_SETTINGS_CHAT_SIZE_MIN}
            max={CUSTOM_SETTINGS_CHAT_SIZE_MAX}
            step={1}
            accessibilityLabel={t("Conversation")}
            onChange={(value) => setFontSlot("chat", { size: value })}
          />
        </View>
        <ColorSwatches
          colors={CHAT_SWATCHES}
          selected={settings.font.chat.color}
          allowFollowTheme
          onSelect={(color) => setFontSlot("chat", { color })}
          label={t("Conversation")}
        />
        <CustomColorInput
          key={`chat-${settings.font.chat.color ?? "theme"}`}
          current={settings.font.chat.color}
          onApply={(color) => setFontSlot("chat", { color })}
        />
        <Text
          style={{
            color: settings.font.chat.color ?? tokens.foreground,
            fontSize: settings.font.chat.size,
            lineHeight: scaledLineHeight(settings.font.chat.size),
            paddingHorizontal: 20,
            paddingTop: 12,
            ...(fontFamily ? { fontFamily } : null),
          }}
        >
          {t("This is a conversation message.")}
        </Text>
      </View>

      <View style={{ paddingTop: 12 }}>
        <RowLabel label={t("Error")} value={`${settings.font.error.size}px`} />
        <View style={{ paddingHorizontal: 20, paddingTop: 4 }}>
          <SettingSlider
            value={settings.font.error.size}
            min={CUSTOM_SETTINGS_ERROR_SIZE_MIN}
            max={CUSTOM_SETTINGS_ERROR_SIZE_MAX}
            step={1}
            accessibilityLabel={t("Error")}
            onChange={(value) => setFontSlot("error", { size: value })}
          />
        </View>
        <ColorSwatches
          colors={ERROR_SWATCHES}
          selected={settings.font.error.color}
          allowFollowTheme={false}
          onSelect={(color) =>
            setFontSlot("error", { color: color ?? CUSTOM_SETTINGS_ERROR_COLOR_DEFAULT })
          }
          label={t("Error")}
        />
        <CustomColorInput
          key={`error-${settings.font.error.color ?? "theme"}`}
          current={settings.font.error.color}
          onApply={(color) => setFontSlot("error", { color })}
        />
        <Text style={[{ paddingHorizontal: 20, paddingTop: 12 }, customErrorTextStyle(settings)]}>
          {t("Couldn't send. Tap to retry.")}
        </Text>
      </View>

      <SectionTitle>{t("Message background")}</SectionTitle>
      <Text
        style={{
          color: tokens.foreground,
          fontSize: 16,
          paddingHorizontal: 20,
          paddingBottom: 4,
        }}
      >
        {t("My message")}
      </Text>
      <ColorSwatches
        colors={MESSAGE_BACKGROUND_SWATCHES}
        selected={settings.messageBackgrounds.user}
        allowFollowTheme
        onSelect={(color) => setMessageBackground("user", color)}
        label={t("My message")}
      />
      <CustomColorInput
        key={`user-bg-${settings.messageBackgrounds.user ?? "theme"}`}
        current={settings.messageBackgrounds.user}
        onApply={(color) => setMessageBackground("user", color)}
      />
      <View
        style={{
          marginHorizontal: 20,
          marginTop: 12,
          borderRadius: 14,
          backgroundColor: settings.messageBackgrounds.user ?? tokens.chatUser,
          paddingHorizontal: 14,
          paddingVertical: 10,
        }}
      >
        <Text style={{ color: tokens.chatUserForeground, fontSize: 15 }}>
          {t("This is my message.")}
        </Text>
      </View>

      <View style={{ paddingTop: 12 }}>
        <Text
          style={{
            color: tokens.foreground,
            fontSize: 16,
            paddingHorizontal: 20,
            paddingBottom: 4,
          }}
        >
          {t("AI reply")}
        </Text>
        <ColorSwatches
          colors={MESSAGE_BACKGROUND_SWATCHES}
          selected={settings.messageBackgrounds.ai}
          allowFollowTheme
          onSelect={(color) => setMessageBackground("ai", color)}
          label={t("AI reply")}
        />
        <CustomColorInput
          key={`ai-bg-${settings.messageBackgrounds.ai ?? "theme"}`}
          current={settings.messageBackgrounds.ai}
          onApply={(color) => setMessageBackground("ai", color)}
        />
        <View
          style={{
            marginHorizontal: 20,
            marginTop: 12,
            borderRadius: 14,
            backgroundColor: settings.messageBackgrounds.ai ?? tokens.muted,
            paddingHorizontal: 14,
            paddingVertical: 10,
          }}
        >
          <Text style={{ color: tokens.foreground, fontSize: 15 }}>
            {t("This is a conversation message.")}
          </Text>
        </View>
      </View>

      <View style={{ paddingTop: 12 }}>
        <Text
          style={{
            color: tokens.foreground,
            fontSize: 16,
            paddingHorizontal: 20,
            paddingBottom: 4,
          }}
        >
          {t("Error")}
        </Text>
        <ColorSwatches
          colors={MESSAGE_BACKGROUND_SWATCHES}
          selected={settings.messageBackgrounds.error}
          allowFollowTheme
          onSelect={(color) => setMessageBackground("error", color)}
          label={t("Error")}
        />
        <CustomColorInput
          key={`error-bg-${settings.messageBackgrounds.error ?? "theme"}`}
          current={settings.messageBackgrounds.error}
          onApply={(color) => setMessageBackground("error", color)}
        />
        <View
          style={{
            marginHorizontal: 20,
            marginTop: 12,
            borderRadius: 14,
            backgroundColor: settings.messageBackgrounds.error ?? native.fill,
            paddingHorizontal: 14,
            paddingVertical: 10,
          }}
        >
          <Text style={customErrorTextStyle(settings)}>{t("Couldn't send. Tap to retry.")}</Text>
        </View>
      </View>

      <SectionTitle>{t("Message actions")}</SectionTitle>
      {settings.messageActions.order.map((id) => {
        const hidden = settings.messageActions.hidden.includes(id);
        return (
          <View
            key={id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 20,
              paddingVertical: 6,
            }}
          >
            <Text
              style={{
                color: hidden ? tokens.mutedForeground : tokens.foreground,
                fontSize: 16,
                flex: 1,
              }}
            >
              {t(ACTION_LABEL_KEYS[id])}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Move up")}
              disabled={settings.messageActions.order[0] === id}
              onPress={() => moveAction(id, -1)}
              style={{ padding: 6 }}
            >
              <NativeSymbol
                ios="chevron.up"
                android="chevron-up-outline"
                size={18}
                color={
                  settings.messageActions.order[0] === id ? tokens.mutedForeground : tokens.link
                }
              />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Move down")}
              disabled={
                settings.messageActions.order[settings.messageActions.order.length - 1] === id
              }
              onPress={() => moveAction(id, 1)}
              style={{ padding: 6 }}
            >
              <NativeSymbol
                ios="chevron.down"
                android="chevron-down-outline"
                size={18}
                color={
                  settings.messageActions.order[settings.messageActions.order.length - 1] === id
                    ? tokens.mutedForeground
                    : tokens.link
                }
              />
            </Pressable>
            <Switch
              accessibilityLabel={
                hidden
                  ? t("Show {label}", { label: t(ACTION_LABEL_KEYS[id]) })
                  : t("Hide {label}", { label: t(ACTION_LABEL_KEYS[id]) })
              }
              value={!hidden}
              onValueChange={() => toggleAction(id)}
            />
          </View>
        );
      })}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Restore defaults")}
        onPress={() => {
          // Resets every interface setting, including each thread's hero height.
          setCustomSettings(userId, {
            heroBackgroundHeights: {},
            chipsRowWidthPct: 100,
            chipsCardWidth: 72,
            font: {
              family: "system",
              title: { size: 17, color: null },
              chat: { size: 17, color: null },
              error: { size: 14, color: CUSTOM_SETTINGS_ERROR_COLOR_DEFAULT },
              imported: settings.font.imported,
            },
            messageBackgrounds: { user: null, ai: null, error: null },
            messageActions: { order: [...DEFAULT_MESSAGE_ACTION_ORDER], hidden: [] },
          });
        }}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: 20,
          paddingVertical: 12,
          marginTop: 12,
          ...(pressed ? { backgroundColor: tokens.muted } : null),
        })}
      >
        <NativeSymbol
          ios="arrow.uturn.backward"
          android="refresh-outline"
          size={20}
          color={tokens.link}
        />
        <Text style={{ color: tokens.foreground, fontSize: 16 }}>{t("Restore defaults")}</Text>
      </Pressable>
    </View>
  );

  if (Sheet) {
    return (
      <NativeSheet Sheet={Sheet} onClose={onClose} label={t("Customize interface")}>
        {content}
      </NativeSheet>
    );
  }
  if (Platform.OS === "ios") {
    return (
      <Modal visible animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
        <View style={{ flex: 1, backgroundColor: tokens.card }}>
          <ScrollView>{content}</ScrollView>
        </View>
      </Modal>
    );
  }
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.4)" }}>
        <ScrollView style={{ maxHeight: "85%" }}>{content}</ScrollView>
      </View>
    </Modal>
  );
}
