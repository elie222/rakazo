import type {
  ComputerStatus,
  ModelRoleChoice,
  Routine,
  VoiceCatalogEntry,
  VoiceInfo,
  VoiceStatus,
} from "@rakazo/contracts";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import type { MobileBot, MobileModel } from "../../lib/mobile-types";
import { NativeSymbol } from "../native-symbol";
import type { ThreadModelPickerRole, ThreadModelSave } from "./thread-model-picker-sheet";

export type ComposerChip = {
  id:
    | "mainModel"
    | "computerModel"
    | "voiceModel"
    | "computer"
    | "routines"
    | "favorites"
    | "background";
  label: string;
  value: string;
  active: boolean;
  onPress: () => void;
};

/**
 * The quick-access row above the composer: the models and functions the chat needs most.
 * Each card shows its live value; the two model cards open a bottom sheet that saves
 * in place, so a pick never leaves the chat.
 */
export function ThreadComposerChips({
  botId,
  currentBot,
  userId,
  catalog,
  mainOverride,
  computerChoice,
  onPickModel,
  favoriteCount,
  onOpenFavorites,
  backgroundLabel,
  onOpenBackground,
}: {
  botId?: string;
  currentBot?: MobileBot;
  userId: string;
  /** The model catalog, fetched by the screen and shared with the composer. */
  catalog: MobileModel[] | null;
  /** The model saved from the sheet, until the chat's bot list catches up with it. */
  mainOverride: ThreadModelSave | null;
  /** The computer model, fetched by the screen so the bot menu shares it. */
  computerChoice: ModelRoleChoice | null;
  onPickModel: (role: ThreadModelPickerRole) => void;
  favoriteCount: number;
  onOpenFavorites: () => void;
  backgroundLabel: string;
  onOpenBackground: () => void;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const router = useRouter();
  const [voiceCatalog, setVoiceCatalog] = useState<VoiceCatalogEntry[] | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [voices, setVoices] = useState<VoiceInfo[] | null>(null);
  const [computerStatus, setComputerStatus] = useState<ComputerStatus | null>(null);
  const [routines, setRoutines] = useState<Routine[] | null>(null);

  useEffect(() => {
    if (!botId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [entries, status] = await Promise.all([
          rpc("voice/catalog"),
          rpc("voice/status", { scope: "account" }),
        ]);
        if (cancelled) return;
        setVoiceCatalog(entries);
        setVoiceStatus(status);
        if (!status.provider) return;
        const list = await rpc("voice/voices", { provider: status.provider, scope: "account" });
        if (!cancelled) setVoices(list);
      } catch {
        // The provider name below stays the fallback.
      }
    })();
    void rpc("computer/status", { botId })
      .then((status) => {
        if (cancelled) return;
        setComputerStatus(status);
      })
      .catch(() => undefined);
    void rpc("routines/list", { botId })
      .then((rows) => {
        if (cancelled) return;
        setRoutines(rows);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [botId, userId]);

  const modelName = (provider: string | null | undefined, modelId: string | null | undefined) => {
    if (!modelId) return t("Choose a model");
    const entry = catalog?.find(
      (item) => item.id === modelId && (!provider || item.provider === provider),
    );
    return entry?.label ?? modelId;
  };

  const mainProvider = mainOverride !== null ? mainOverride.provider : currentBot?.modelProvider;
  const mainModelId = mainOverride !== null ? mainOverride.modelId : currentBot?.modelId;

  const chips: ComposerChip[] = useMemo(() => {
    const mainValue = modelName(mainProvider, mainModelId);
    const computerModelValue = computerChoice
      ? modelName(computerChoice.provider, computerChoice.modelId)
      : t("Same as main model");
    // The voice's own name (e.g. its label from the provider's voice list); the
    // provider's catalog name, then its id, only when no voice name resolves.
    const voiceValue =
      voices?.find((voice) => voice.id === voiceStatus?.voiceId)?.label ??
      voiceCatalog?.find((entry) => entry.id === voiceStatus?.provider)?.name ??
      voiceStatus?.provider ??
      t("Voice settings");
    const computerMode = currentBot?.computerMode;
    const computerModeValue =
      computerMode === "team" ? t("Team") : computerMode === "dedicated" ? t("Private") : t("Off");
    const computerValue = computerStatus
      ? computerStatus.state === "running"
        ? t("Online")
        : computerStatus.state === "booting"
          ? t("Booting live desktop…")
          : computerStatus.state === "suspended"
            ? t("Computer is asleep. Take control to wake it.")
            : computerStatus.state === "error"
              ? t("Computer failed to boot")
              : t("Computer is stopped")
      : computerModeValue;
    // "Running" means enabled: Routine has no live-run field, only `active`.
    const runningRoutines = routines?.filter((routine) => routine.active).length;
    const routinesValue =
      runningRoutines === undefined
        ? t("Routine tasks")
        : t("{count} running", { count: runningRoutines });
    return [
      {
        id: "mainModel",
        label: t("Main model"),
        value: mainValue,
        active: Boolean(mainModelId),
        onPress: () => onPickModel("main"),
      },
      {
        id: "computerModel",
        label: t("Computer model"),
        value: computerModelValue,
        active: Boolean(computerChoice),
        onPress: () => onPickModel("computer"),
      },
      {
        id: "voiceModel",
        label: t("Voice model"),
        value: voiceValue,
        active: Boolean(voiceStatus?.provider),
        onPress: () => router.push("/(settings)/voice"),
      },
      {
        id: "computer",
        label: t("Computer"),
        value: computerValue,
        active: computerStatus ? computerStatus.state === "running" : Boolean(computerMode),
        onPress: () => {
          if (!botId) return;
          router.push({ pathname: "/computer", params: { botId } });
        },
      },
      {
        id: "routines",
        label: t("Routines"),
        value: routinesValue,
        active: (runningRoutines ?? 0) > 0,
        onPress: () => {
          router.push({ pathname: "/routines", params: botId ? { botId } : {} });
        },
      },
      {
        id: "favorites",
        label: t("Favorites"),
        value:
          favoriteCount > 0 ? t("{count} favorites", { count: favoriteCount }) : t("No favorites"),
        active: favoriteCount > 0,
        onPress: onOpenFavorites,
      },
      {
        id: "background",
        label: t("Background"),
        value: backgroundLabel,
        active: backgroundLabel !== t("Default"),
        onPress: onOpenBackground,
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    botId,
    currentBot,
    computerChoice,
    voiceCatalog,
    voiceStatus,
    voices,
    computerStatus,
    routines,
    mainProvider,
    mainModelId,
    catalog,
    router,
    favoriteCount,
    backgroundLabel,
    t,
  ]);

  if (!botId || !currentBot) return null;
  // The quick row from the chat mockup (v3): five big cards in one horizontally
  // scrolling row, icon on top, name in the middle, live value underneath in
  // small grey type. Card width matches the v3 grid (412px phone, 12px insets,
  // 7px gaps -> 72px a card); the row scrolls so all seven stay reachable.
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 7, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 }}
      style={{
        flexShrink: 0,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: tokens.border,
        backgroundColor: tokens.background,
      }}
    >
      {chips.map((chip) => (
        <Pressable
          key={chip.id}
          accessibilityRole="button"
          accessibilityLabel={`${chip.label}: ${chip.value}`}
          onPress={chip.onPress}
          style={{
            width: 72,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: tokens.border,
            backgroundColor: tokens.card,
            paddingHorizontal: 2,
            paddingTop: 8,
            paddingBottom: 7,
            alignItems: "center",
            gap: 1,
          }}
        >
          {chip.id === "computer" && computerStatus?.state === "running" ? (
            <View
              style={{
                position: "absolute",
                top: 7,
                right: 8,
                width: 7,
                height: 7,
                borderRadius: 3.5,
                backgroundColor: tokens.success,
              }}
            />
          ) : null}
          <View style={{ marginBottom: 2 }}>
            <NativeSymbol
              ios={
                chip.id === "mainModel"
                  ? "cpu"
                  : chip.id === "computerModel"
                    ? "desktopcomputer"
                    : chip.id === "voiceModel"
                      ? "waveform"
                      : chip.id === "computer"
                        ? "macbook"
                        : chip.id === "routines"
                          ? "clock.arrow.circlepath"
                          : chip.id === "favorites"
                            ? "bookmark"
                            : "photo"
              }
              android={
                chip.id === "mainModel"
                  ? "hardware-chip-outline"
                  : chip.id === "computerModel"
                    ? "desktop-outline"
                    : chip.id === "voiceModel"
                      ? "mic-outline"
                      : chip.id === "computer"
                        ? "laptop-outline"
                        : chip.id === "routines"
                          ? "time-outline"
                          : chip.id === "favorites"
                            ? "bookmark-outline"
                            : "image-outline"
              }
              size={21}
              color={tokens.link}
            />
          </View>
          <Text
            style={{
              color: tokens.foreground,
              fontSize: 12.5,
              fontWeight: "700",
              lineHeight: 15,
            }}
            numberOfLines={1}
          >
            {chip.label}
          </Text>
          <Text
            style={{ color: tokens.mutedForeground, fontSize: 10, lineHeight: 12.5 }}
            numberOfLines={1}
          >
            {chip.value}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
