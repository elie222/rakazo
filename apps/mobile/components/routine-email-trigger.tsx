import type { RoutineEmailSenders } from "@rakazo/contracts";
import { useI18n } from "../lib/i18n";
import type { BotEmail } from "./bot-email";
import { useBotEmailRows } from "./bot-email";
import { MenuPicker } from "./menu-picker";
import { SettingsGroup, SettingsRow } from "./settings-group";

/** The email trigger in the routine editor: the bot's address, who can start it, and removal. */
export function RoutineEmailTrigger({
  botId,
  botName,
  email,
  senders,
  onChange,
  onRemove,
}: {
  botId: string;
  botName: string;
  email: BotEmail;
  senders: RoutineEmailSenders;
  onChange: (senders: RoutineEmailSenders) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const rows = useBotEmailRows({ botId, botName, email });
  const domain = email.address?.domain;

  return (
    <SettingsGroup label={t("When an email arrives")}>
      {rows}
      {domain && email.ownerDomain ? (
        <MenuPicker
          key="senders"
          label={t("Who can start it")}
          value={senders}
          choices={[
            { key: "owner", label: t("Only me") },
            { key: "domain", label: t("Anyone at @{domain}", { domain: email.ownerDomain }) },
          ]}
          onChange={(key) => onChange(key as RoutineEmailSenders)}
        />
      ) : null}
      <SettingsRow
        key="remove"
        accessibilityRole="button"
        destructive
        title={t("Remove email trigger")}
        onPress={onRemove}
      />
    </SettingsGroup>
  );
}
