import type { ComputerModelTarget, ThinkingLevel } from "@rakazo/contracts";
import { computerModelKey, createComputerModelSettings } from "@rakazo/core";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { captureApiRequestContext, currentApiBase, rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { thinkingLevelLabel } from "../lib/thinking-level";
import { MenuPicker } from "./menu-picker";
import { SettingsGroup } from "./settings-group";

export function ComputerModelSettings({
  target,
  userId,
  spaceId,
  label,
}: {
  target: ComputerModelTarget;
  userId: string;
  spaceId: string;
  label?: string;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [advanced, setAdvanced] = useState(false);
  const targetKey = JSON.stringify(target);
  const base = currentApiBase();
  const controller = useMemo(() => {
    const context = captureApiRequestContext(spaceId);
    const captured: ComputerModelTarget = JSON.parse(targetKey);
    const input = { target: captured, expectedUserId: userId };
    return createComputerModelSettings(
      {
        load: async () => rpc("models/computer", input, { requestContext: await context }),
        save: async (selection) =>
          rpc("models/setComputer", { ...input, selection }, { requestContext: await context }),
      },
      JSON.stringify([base, userId, spaceId, targetKey]),
    );
  }, [base, userId, spaceId, targetKey]);
  useEffect(() => {
    void controller.load();
  }, [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const selection = state.view?.selection ?? null;
  const key = computerModelKey(selection);
  const selected = state.view?.options.find((entry) => computerModelKey(entry) === key);
  const blocked = state.busy || state.stale;
  const choices = [
    {
      key: "inherit",
      label: target.kind === "bot" ? t("Use provider default") : t("Same as main model"),
    },
    ...(target.kind === "bot" ? [{ key: "main", label: t("Same as main model") }] : []),
    ...(selection?.mode === "model" && !selected
      ? [{ key, label: `${selection.modelId} — ${t("Unavailable")}` }]
      : []),
    ...(state.view?.options.map((entry) => ({
      key: computerModelKey(entry),
      label: entry.label,
    })) ?? []),
  ];
  return (
    <SettingsGroup label={label ?? t("Computer-use model")}>
      {state.view ? (
        <View pointerEvents={blocked ? "none" : "auto"} accessibilityState={{ disabled: blocked }}>
          <MenuPicker
            label={t("Computer-use model")}
            choices={choices}
            value={key}
            onChange={(value) => {
              if (blocked) return;
              const choice = state.view?.options.find((entry) => computerModelKey(entry) === value);
              void controller.save(
                value === "inherit"
                  ? null
                  : value === "main"
                    ? { mode: "main" }
                    : choice
                      ? {
                          mode: "model",
                          provider: choice.provider,
                          modelId: choice.modelId,
                          credentialId: choice.credentialId,
                          thinkingLevel: null,
                        }
                      : selection,
              );
            }}
          />
          {selected?.thinkingLevels.length && selection?.mode === "model" ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: advanced }}
                onPress={() => setAdvanced(!advanced)}
                style={{ minHeight: 44, justifyContent: "center" }}
              >
                <Text style={{ color: tokens.foreground }}>{t("Thinking")}</Text>
              </Pressable>
              {advanced ? (
                <MenuPicker
                  label={t("Computer thinking")}
                  choices={[
                    { key: "", label: t("Default (Medium)") },
                    ...selected.thinkingLevels.map((level) => ({
                      key: level,
                      label: thinkingLevelLabel(level, t),
                    })),
                  ]}
                  value={selection.thinkingLevel ?? ""}
                  onChange={(value) => {
                    if (!blocked)
                      void controller.save({
                        ...selection,
                        thinkingLevel: (value || null) as ThinkingLevel | null,
                      });
                  }}
                />
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}
      {state.busy && !state.view ? (
        <Text style={{ color: tokens.mutedForeground }}>{t("Loading…")}</Text>
      ) : null}
      {state.error ? (
        <View>
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {state.error}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={state.busy}
            onPress={() => void controller.load()}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text style={{ color: tokens.foreground }}>{t("Retry")}</Text>
          </Pressable>
        </View>
      ) : null}
    </SettingsGroup>
  );
}
