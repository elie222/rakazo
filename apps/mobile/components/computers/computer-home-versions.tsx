import { useLingui } from "@lingui/react/macro";
import { COMPUTER_RUNNING_ERROR } from "@rakazo/contracts";
import type { ReactElement } from "react";
import { useState } from "react";
import { Alert, View } from "react-native";
import { selectedSpaceId } from "../../lib/api/api";
import { errorText } from "../../lib/api/user-error";
import { native } from "../../lib/native/native";
import { rpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { NativeSymbol } from "../native/native-symbol";
import { SettingsRow } from "../settings/settings-group";
import { MenuPickerMenu } from "../ui/menu-picker";

/**
 * Restores an earlier saved copy of the bot computer's files, offered once the computer has one.
 * The computer gets the chosen copy on its next start.
 */
export function useComputerHomeVersionRows(botId: string | undefined): ReactElement[] {
  const { t, i18n } = useLingui();
  // The bot's own Space, the one selected when its settings opened, whatever is selected later.
  const [spaceId] = useState(() => selectedSpaceId() ?? undefined);
  const read = rpcQuery("computer/homeVersions", { botId: botId ?? "" }, spaceId);
  const versions = useScreenQuery(read, { enabled: Boolean(botId), onForeground: false });
  const restore = useSave({
    target: spaceId ? { scope: "space", spaceId } : undefined,
    save: async ({ botId, versionId }: { botId: string; versionId: string }, send) => {
      await send("computer/restoreHomeVersion", { botId, versionId });
    },
    stale: [read.queryKey],
  });

  const list = versions.error ? [] : (versions.data ?? []);
  if (!botId || !list.length) return [];
  const format = new Intl.DateTimeFormat(i18n.locale || undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const choices = list.map((version) => ({
    key: version.id,
    label: format.format(new Date(version.savedAt)),
  }));
  const failure = restore.error;
  const error = failure
    ? "code" in failure && failure.code === COMPUTER_RUNNING_ERROR
      ? t`Stop the computer first.`
      : errorText(failure, t`Could not restore files`)
    : null;

  function confirm(versionId: string) {
    const savedAt = choices.find((choice) => choice.key === versionId)?.label;
    if (!botId || !savedAt) return;
    Alert.alert(
      t`Restore files from ${savedAt}?`,
      t`The computer gets these files when it next starts. Its current files stay restorable.`,
      [
        { text: t`Cancel`, style: "cancel" },
        { text: t`Restore`, onPress: () => restore.run({ botId, versionId }) },
      ],
    );
  }

  return [
    <MenuPickerMenu
      key="restore-version"
      choices={choices}
      disabled={restore.pending}
      label={t`Restore earlier version`}
      onChange={confirm}
      value=""
    >
      <View>
        <SettingsRow
          accessible
          accessibilityRole="button"
          accessibilityState={{ disabled: restore.pending }}
          dimmed={restore.pending}
          title={restore.pending ? t`Restoring…` : t`Restore earlier version`}
          trailing={
            <NativeSymbol
              android="chevron-expand"
              color={native.tertiaryLabel}
              ios="chevron.up.chevron.down"
              size={13}
            />
          }
        />
      </View>
    </MenuPickerMenu>,
    ...(error
      ? [<SettingsRow key="restore-error" accessibilityRole="alert" destructive title={error} />]
      : []),
  ];
}
