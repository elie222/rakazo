import { vi } from "vitest";

vi.mock("../../components/native/native-switch", () => ({
  NativeSwitch: ({
    value,
    disabled,
    onValueChange,
    accessibilityLabel,
  }: {
    value: boolean;
    disabled?: boolean;
    onValueChange: (next: boolean) => void;
    accessibilityLabel?: string;
  }) => (
    <input
      type="checkbox"
      aria-label={accessibilityLabel}
      checked={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.checked)}
    />
  ),
}));
vi.mock("../../components/ui/menu-picker", () => ({
  MenuPicker: ({
    choices,
    onChange,
  }: {
    choices: { key: string; label: string }[];
    onChange: (key: string) => void;
  }) => (
    <div>
      {choices.map(({ key, label }) => (
        <button key={key} type="button" onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
    busy,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
    busy?: boolean;
  }) => (
    <button type="button" disabled={disabled || busy} onClick={onPress}>
      {label}
    </button>
  ),
}));
