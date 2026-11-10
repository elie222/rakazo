import { useLingui } from "@lingui/react/macro";
import type { ApprovalMode } from "@rakazo/contracts";
import { View } from "react-native";
import type { ApprovalSettings } from "../lib/approval-settings";
import { native } from "../lib/native";
import { MenuPickerMenu } from "./menu-picker";
import { NativeSymbol } from "./native-symbol";
import { SettingsRow } from "./settings-group";

/** The approval mode as a settings row; tapping opens a native menu with the current mode checked. */
export function ApprovalModeRow({
  approvals,
  disabled = false,
}: {
  approvals: ApprovalSettings;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const { settings, pending, loadError } = approvals;
  const choices: { key: ApprovalMode; label: string }[] = [
    { key: "never", label: t`Never ask` },
    // Auto needs an approval model; it stays listed while chosen so the choice is visible.
    ...(settings?.checkerAvailable || settings?.mode === "auto"
      ? [{ key: "auto" as const, label: t`Auto` }]
      : []),
    { key: "ask", label: t`Ask` },
  ];
  const current = choices.find((choice) => choice.key === settings?.mode)?.label;
  const detail =
    settings?.mode === "auto" && !settings.checkerAvailable
      ? t`Add a model in Settings to use this.`
      : settings?.mode === "auto"
        ? t`A model approves routine actions and asks you about the rest.`
        : settings?.mode === "never"
          ? t`Asks only before purchases and the first use of your computer. Only Block rules apply.`
          : settings?.mode === "ask"
            ? t`Asks before sending, spending or changing anything in your apps.`
            : undefined;
  const held = disabled || pending || !settings;
  // A failed read, first or on return, may leave the mode out of date, so offer to read it again.
  if (loadError) {
    return (
      <SettingsRow
        accessibilityRole="button"
        detail={loadError}
        disabled={disabled}
        onPress={approvals.retry}
        title={t`Approvals`}
        value={t`Retry`}
      />
    );
  }
  return (
    <MenuPickerMenu
      choices={choices}
      disabled={held}
      label={t`Approvals`}
      onChange={(key) => {
        const choice = choices.find((entry) => entry.key === key);
        if (choice) void approvals.setMode(choice.key);
      }}
      value={settings?.mode ?? ""}
    >
      <View>
        <SettingsRow
          accessible
          // Named explicitly, so the menu symbol isn't read out with the row.
          accessibilityHint={detail}
          accessibilityLabel={t`Approvals`}
          accessibilityRole="button"
          accessibilityState={{ disabled: held }}
          accessibilityValue={current ? { text: current } : undefined}
          detail={detail}
          dimmed={pending}
          title={t`Approvals`}
          trailing={
            <NativeSymbol
              android="chevron-expand"
              color={native.tertiaryLabel}
              ios="chevron.up.chevron.down"
              size={13}
            />
          }
          value={current}
        />
      </View>
    </MenuPickerMenu>
  );
}

/** Opens the saved rules; shown only when there are some, since rules come from approval cards. */
export function ApprovalRulesRow({
  count,
  disabled = false,
  onPress,
}: {
  count: number;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { t } = useLingui();
  return (
    <SettingsRow
      accessibilityRole="button"
      chevron="right"
      disabled={disabled}
      onPress={onPress}
      title={t`Rules`}
      value={String(count)}
    />
  );
}
