import type { CronPreset } from "@rakazo/core";
import { cronFromPreset } from "@rakazo/core";
import { expect, it, vi } from "vitest";
import { RoutineScheduleEditor } from "../components/routine-schedule-editor";

vi.mock("./i18n", () => ({ useUiLocale: () => "en" }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("../components/menu-picker", () => ({ MenuPicker: () => null }));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: () => null,
  SettingsInputRow: () => null,
}));

it.each([
  ["Every week", "Every Monday", "0 9 * * 1"],
  ["Every month", "Monthly on the 1st", "0 9 1 * *"],
] as const)("names the fixed date of %s without changing its preset", (freq, label, cron) => {
  const value: CronPreset = { freq, time: "9:00 AM", n: 1, unit: "days", cron: "" };
  const onChange = vi.fn();
  const editor = RoutineScheduleEditor({ value, onChange, onRemove: vi.fn() });
  const picker = editor.props.children[0];
  expect(picker.props.choices.find((choice: { key: string }) => choice.key === freq)).toEqual({
    key: freq,
    label,
  });
  picker.props.onChange(freq);
  expect(onChange).toHaveBeenCalledWith(value);
  expect(cronFromPreset(onChange.mock.calls[0]?.[0])).toBe(cron);
});
