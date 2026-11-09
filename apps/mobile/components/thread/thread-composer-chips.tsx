import type { ModelRoleChoice } from "@rakazo/contracts";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text } from "react-native";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import type { MobileBot, MobileModel } from "../../lib/mobile-types";
import { NativeSymbol } from "../native-symbol";

export type ComposerChip = {
  id: "mainModel" | "computerModel" | "voiceModel" | "computer" | "routines";
  label: string;
  value: string;
  active: boolean;
  onPress: () => void;
};

/**
 * The quick-access row above the composer: the models and functions the chat needs most.
 * Each chip shows its current value and opens the screen that changes it.
 */
export function ThreadComposerChips({
  botId,
  currentBot,
  userId,
}: {
  botId?: string;
  currentBot?: MobileBot;
  userId: string;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const router = useRouter();
  const [catalog, setCatalog] = useState<MobileModel[] | null>(null);
  const [computerChoice, setComputerChoice] = useState<ModelRoleChoice | null>(null);
  const [speechModel, setSpeechModel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([rpc("models/list"), rpc("models/credentials")])
      .then(([list]) => {
        if (cancelled) return;
        setCatalog(list as MobileModel[]);
      })
      .catch(() => undefined);
    void rpc("models/role", { role: "computer", expectedUserId: userId, scope: "account" })
      .then((view: { primary?: ModelRoleChoice | null }) => {
        if (cancelled) return;
        const primary = view.primary ?? null;
        setComputerChoice(primary);
      })
      .catch(() => undefined);
    void rpc("voice/status", { scope: "account" })
      .then((status: { provider?: string | null; voiceId?: string | null }) => {
        if (cancelled) return;
        const model = status.provider ?? null;
        setSpeechModel(model);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const modelName = (provider: string | null | undefined, modelId: string | null | undefined) => {
    if (!modelId) return t("Choose a model");
    const entry = catalog?.find(
      (item) => item.id === modelId && (!provider || item.provider === provider),
    );
    return entry?.label ?? modelId;
  };

  const chips: ComposerChip[] = useMemo(() => {
    const mainValue = currentBot
      ? modelName(currentBot.modelProvider, currentBot.modelId)
      : t("Choose a model");
    const computerModelValue = computerChoice
      ? modelName(computerChoice.provider, computerChoice.modelId)
      : t("Same as main model");
    const voiceValue = speechModel ?? t("Voice settings");
    const computerMode = currentBot?.computerMode;
    const computerModeValue =
      computerMode === "team" ? t("Team") : computerMode === "dedicated" ? t("Private") : t("Off");
    return [
      {
        id: "mainModel",
        label: t("Main model"),
        value: mainValue,
        active: Boolean(currentBot?.modelId),
        onPress: () => {
          if (!botId) return;
          router.push({
            pathname: "/bot-model",
            params: {
              botId,
              value: currentBot?.modelId
                ? `${currentBot.modelProvider ?? ""}:${currentBot.modelId}`
                : "",
            },
          });
        },
      },
      {
        id: "computerModel",
        label: t("Computer model"),
        value: computerModelValue,
        active: Boolean(computerChoice),
        onPress: () => router.push("/(settings)/models"),
      },
      {
        id: "voiceModel",
        label: t("Voice model"),
        value: voiceValue,
        active: Boolean(speechModel),
        onPress: () => router.push("/(settings)/voice"),
      },
      {
        id: "computer",
        label: t("Computer"),
        value: computerModeValue,
        active: Boolean(computerMode),
        onPress: () => {
          if (!botId) return;
          router.push({ pathname: "/computer", params: { botId } });
        },
      },
      {
        id: "routines",
        label: t("Routines"),
        value: t("Routine tasks"),
        active: false,
        onPress: () => {
          router.push({ pathname: "/routines", params: botId ? { botId } : {} });
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, currentBot, computerChoice, speechModel, catalog, router, t]);

  if (!botId || !currentBot) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingHorizontal: 4, paddingVertical: 8 }}
      style={{ flexShrink: 0 }}
    >
      {chips.map((chip) => (
        <Pressable
          key={chip.id}
          accessibilityRole="button"
          accessibilityLabel={`${chip.label}: ${chip.value}`}
          onPress={chip.onPress}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: chip.active ? tokens.accent : tokens.border,
            backgroundColor: chip.active ? tokens.card : tokens.card,
            paddingHorizontal: 12,
            paddingVertical: 7,
          }}
        >
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
                      : "clock.arrow.circlepath"
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
                      : "time-outline"
            }
            size={15}
            color={chip.active ? tokens.accent : tokens.mutedForeground}
          />
          <Text style={{ color: tokens.mutedForeground, fontSize: 13 }} numberOfLines={1}>
            {chip.label}
          </Text>
          <Text
            style={{
              color: chip.active ? tokens.foreground : tokens.mutedForeground,
              fontSize: 13,
              fontWeight: chip.active ? "600" : "400",
              maxWidth: 140,
            }}
            numberOfLines={1}
          >
            {chip.value}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
