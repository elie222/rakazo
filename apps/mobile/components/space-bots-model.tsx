import { botsWithOwnModel } from "@rakazo/core";
import { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import type { MobileBot } from "../lib/api";
import { captureApiRequestContext, rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { SettingsGroup, SettingsRow } from "./settings-group";

/**
 * Names the bots that ignore the main model because they pick their own and, after a confirm,
 * moves them all onto the space default.
 */
export function SpaceBotsModel({
  bots,
  spaceId,
  onSwitched,
}: {
  bots: MobileBot[];
  /** The Space whose bots these are; the selected one when unset. */
  spaceId?: string;
  onSwitched: () => Promise<void>;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [pending, setPending] = useState(false);
  const [moved, setMoved] = useState(0);
  const [failed, setFailed] = useState<string[]>([]);
  const pinned = botsWithOwnModel(bots);
  const count = pinned.length;
  // A bot changed elsewhere since the failure no longer needs a retry.
  const stillFailed = pinned.filter((bot) => failed.includes(bot.id)).map((bot) => bot.name);

  async function switchAll() {
    setPending(true);
    setMoved(0);
    setFailed([]);
    const requestContext = captureApiRequestContext(spaceId);
    // Each bot saves on its own; any that fail are named and stay listed to retry.
    const results = await Promise.allSettled(
      pinned.map(async (bot) =>
        rpc(
          "bots/update",
          { botId: bot.id, modelProvider: null, modelId: null, thinkingLevel: null },
          { requestContext: await requestContext },
        ),
      ),
    );
    setMoved(results.filter((result) => result.status === "fulfilled").length);
    setFailed(
      pinned.filter((_, index) => results[index]?.status === "rejected").map((bot) => bot.id),
    );
    await onSwitched();
    setPending(false);
  }

  function confirm() {
    Alert.alert(
      count === 1
        ? t("Switch 1 bot to the space default?")
        : t("Switch {count} bots to the space default?", { count }),
      t("Their own model is cleared. You can pick one again in each bot."),
      [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Switch"), onPress: () => void switchAll() },
      ],
    );
  }

  if (count === 0 && !moved) return null;
  const summary =
    count === 1
      ? t("1 bot has its own model:")
      : t("{count} bots have their own model:", { count });
  return (
    <View style={styles.section}>
      <SettingsGroup
        label={t("Bot models")}
        footer={count ? `${summary} ${pinned.map((bot) => bot.name).join(", ")}` : undefined}
      >
        {count ? (
          <SettingsRow
            key="switch"
            accessibilityRole="button"
            title={pending ? t("Switching…") : t("Use space default")}
            tinted
            disabled={pending}
            onPress={confirm}
          />
        ) : null}
      </SettingsGroup>
      {moved ? (
        <Text style={styles.status}>
          {moved === 1
            ? t("1 bot now uses the space default.")
            : t("{count} bots now use the space default.", { count: moved })}
        </Text>
      ) : null}
      {stillFailed.length ? (
        <Text accessibilityRole="alert" style={[styles.status, styles.error]}>
          {t("Could not switch {failedNames}. Try again.", { failedNames: stillFailed.join(", ") })}
        </Text>
      ) : null}
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    section: { gap: 8 },
    status: { color: native.secondaryLabel, fontSize: 13, paddingHorizontal: 16 },
    error: { color: tokens.destructive },
  });
}
