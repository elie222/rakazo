import type { ComputerModelTarget, ThinkingLevel } from "@rakazo/contracts";
import { computerModelKey, createComputerModelSettings } from "@rakazo/core";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { captureApiRequestContext, currentApiBase, rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { thinkingLevelLabel } from "../lib/thinking-level";
import { errorText } from "../lib/user-error";
import { LoadFailure } from "./load-failure";
import { MenuPicker } from "./menu-picker";

/** One settings row; `label` names the connection it configures, if any. */
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
  // The default effort is medium, so offer the control only where that default is real.
  const thinkingLevels =
    selected && selected.thinkingLevels.length > 1 && selected.thinkingLevels.includes("medium")
      ? selected.thinkingLevels
      : [];
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
      group: entry.connection,
    })) ?? []),
  ];
  return (
    <View>
      {state.view ? (
        <View pointerEvents={blocked ? "none" : "auto"} accessibilityState={{ disabled: blocked }}>
          <MenuPicker
            label={label ?? t("Computer-use model")}
            showLabel={Boolean(label)}
            plain={!label}
            menuTitle={t("Computer-use model")}
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
          {thinkingLevels.length > 0 && selection?.mode === "model" ? (
            <MenuPicker
              divider
              plain={!label}
              label={t("Computer thinking")}
              choices={[
                {
                  key: "",
                  label: t("Default ({level})", { level: thinkingLevelLabel("medium", t) }),
                },
                ...thinkingLevels.map((level) => ({
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
        </View>
      ) : state.busy ? (
        <Text style={{ color: tokens.mutedForeground, padding: 16 }}>{t("Loading…")}</Text>
      ) : null}
      {state.error ? (
        <View style={{ padding: 16 }}>
          <LoadFailure
            message={errorText(state.error, t("Could not load model settings"))}
            onRetry={() => void controller.load()}
          />
        </View>
      ) : null}
    </View>
  );
}
