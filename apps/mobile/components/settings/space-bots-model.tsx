import { ph, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { botsWithOwnModel } from "@rakazo/core";
import { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import type { MobileBot } from "../../lib/api/mobile-types";
import { mobileTokens } from "../../lib/appearance/appearance";
import { native, useThemedStyles } from "../../lib/native/native";
import { useSave } from "../../lib/query/query";
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
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const [moved, setMoved] = useState(0);
  const [failed, setFailed] = useState<string[]>([]);
  const pinned = botsWithOwnModel(bots);
  const count = pinned.length;
  // A bot changed elsewhere since the failure no longer needs a retry.
  const stillFailed = pinned.filter((bot) => failed.includes(bot.id)).map((bot) => bot.name);

  const switching = useSave({
    target: spaceId ? { scope: "space", spaceId } : undefined,
    save: async (bots: MobileBot[], send) => {
      // Each bot saves on its own; any that fail are named and stay listed to retry.
      const results = await Promise.allSettled(
        bots.map((bot) =>
          send("bots/update", {
            botId: bot.id,
            modelProvider: null,
            modelId: null,
            thinkingLevel: null,
          }),
        ),
      );
      await onSwitched();
      return results;
    },
    onSaved: (results, bots) => {
      setMoved(results.filter((result) => result.status === "fulfilled").length);
      setFailed(
        bots.filter((_, index) => results[index]?.status === "rejected").map((bot) => bot.id),
      );
    },
  });
  const pending = switching.pending;

  function switchAll() {
    setMoved(0);
    setFailed([]);
    switching.run(pinned);
  }

  function confirm() {
    Alert.alert(
      t`${plural(count, { one: "Switch # bot to the space default?", other: "Switch # bots to the space default?" })}`,
      t`Their own model is cleared. You can pick one again in each bot.`,
      [
        { text: t`Cancel`, style: "cancel" },
        { text: t`Switch`, onPress: switchAll },
      ],
    );
  }

  if (count === 0 && !moved) return null;
  const names = pinned.map((bot) => bot.name).join(", ");
  return (
    <View style={styles.section}>
      <SettingsGroup
        label={t`Bot models`}
        footer={
          count
            ? t`${plural(count, { one: `# bot has its own model: ${names}`, other: `# bots have their own model: ${names}` })}`
            : undefined
        }
      >
        {count ? (
          <SettingsRow
            key="switch"
            accessibilityRole="button"
            title={pending ? t`Switching…` : t`Use space default`}
            tinted
            disabled={pending}
            onPress={confirm}
          />
        ) : null}
      </SettingsGroup>
      {moved ? (
        <Text style={styles.status}>
          {t`${plural(moved, { one: "# bot now uses the space default.", other: "# bots now use the space default." })}`}
        </Text>
      ) : null}
      {stillFailed.length ? (
        <Text accessibilityRole="alert" style={[styles.status, styles.error]}>
          {t`Could not switch ${ph({ failedNames: stillFailed.join(", ") })}. Try again.`}
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
