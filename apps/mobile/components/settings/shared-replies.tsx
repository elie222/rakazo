import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import { Alert } from "react-native";
import { errorText } from "../../lib/api/user-error";
import { useUiLocale } from "../../lib/i18n/i18n";
import { useResolvedAppearance } from "../../lib/native/native";
import { accountRpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { ACCOUNT_SETTINGS } from "../../lib/query/settings-target";
import { SettingsGroup, SettingsRow } from "./settings-group";

/** Every bot reply the user shared by link, in any Space; shown only once there is one. */
export function SharedRepliesGroup() {
  const { t } = useLingui();
  const locale = useUiLocale();
  const colorScheme = useResolvedAppearance();
  const read = accountRpcQuery("replyShares/list");
  const shares = useScreenQuery(read).data;
  const remove = useSave({
    target: ACCOUNT_SETTINGS,
    save: (shareId: string, send) => send("replyShares/remove", { shareId }),
    stale: [read.queryKey],
    onFailed: (cause) => Alert.alert(t`Could not continue`, errorText(cause, t`Try again.`)),
  });
  if (!shares?.length) return null;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  return (
    <SettingsGroup accessibilityLabel={t`Shared links`} label={t`Shared links`}>
      {shares.map((share) => (
        <MenuView
          key={share.id}
          actions={[
            {
              id: "remove",
              title: t`Remove`,
              attributes: { destructive: true, disabled: remove.pending },
            },
          ]}
          colorScheme={colorScheme}
          onPressAction={() => remove.run(share.id)}
          title={share.botName}
        >
          <SettingsRow
            accessible
            accessibilityRole="button"
            title={share.botName}
            detail={share.preview}
            value={date.format(new Date(share.createdAt))}
          />
        </MenuView>
      ))}
    </SettingsGroup>
  );
}
