import { useLingui } from "@lingui/react/macro";
import type { ApprovalMode } from "@rakazo/contracts";
import type { createQueuedSave } from "../../lib/query/queued-save";
import { SettingsGroup, SettingsSwitch } from "../settings/settings-group";
import type { MenuPickerChoice } from "../ui/menu-picker";
import { MenuPicker } from "../ui/menu-picker";

type BooleanSave = ReturnType<typeof createQueuedSave<boolean>>;

/** The bot's permission rows: approval mode, then the switches it has changed from defaults. */
export function BotPermissionsSection({
  botId,
  changed,
  approvalMode,
  approvalChoices,
  autoAvailable,
  onApprovalModeChange,
  dailyCheckIns,
  crossSpaceCommunication,
  fleetManagement,
  dailyCheckInsSave,
  crossSpaceSave,
  fleetSave,
  onError,
}: {
  botId: string | undefined;
  changed: {
    dailyCheckIns: boolean;
    crossSpaceCommunication: boolean;
    fleetManagement: boolean;
  } | null;
  approvalMode: ApprovalMode | "space";
  approvalChoices: MenuPickerChoice[];
  autoAvailable: boolean;
  onApprovalModeChange: (mode: ApprovalMode | "space") => void;
  dailyCheckIns: boolean;
  crossSpaceCommunication: boolean;
  fleetManagement: boolean;
  dailyCheckInsSave: BooleanSave;
  crossSpaceSave: BooleanSave;
  fleetSave: BooleanSave;
  onError: (message: string | null) => void;
}) {
  const { t } = useLingui();
  return (
    <SettingsGroup
      label={t`Permissions`}
      footer={
        approvalMode === "auto" && !autoAvailable
          ? t`Auto needs an approval model; until one is set, this bot asks.`
          : undefined
      }
    >
      <MenuPicker
        choices={approvalChoices}
        label={t`Approval mode`}
        onChange={(key) => onApprovalModeChange(key === "space" ? "space" : (key as ApprovalMode))}
        value={approvalMode}
      />
      {changed?.dailyCheckIns ? (
        <SettingsSwitch
          label={t`Daily check-ins on unfinished work`}
          value={dailyCheckIns}
          onChange={(value) => {
            if (!botId) return;
            onError(null);
            dailyCheckInsSave.update(value);
          }}
        />
      ) : null}
      {changed?.crossSpaceCommunication ? (
        <SettingsSwitch
          label={t`Allow cross-space bot communication`}
          value={crossSpaceCommunication}
          onChange={(value) => {
            if (!botId) return;
            onError(null);
            crossSpaceSave.update(value);
          }}
        />
      ) : null}
      {changed?.fleetManagement ? (
        <SettingsSwitch
          label={t`Manage other bots`}
          onChange={(value) => {
            if (!botId) return;
            onError(null);
            fleetSave.update(value);
          }}
          value={fleetManagement}
        />
      ) : null}
    </SettingsGroup>
  );
}
