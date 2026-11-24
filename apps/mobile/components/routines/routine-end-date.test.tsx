import { expect, it, vi } from "vitest";
import { RoutineEndDate } from "./routine-end-date";

vi.mock("../../lib/i18n/i18n", () => ({
  useDateLocale: () => "en-US",
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("../settings/settings-date-row", () => ({
  SettingsDateRow: () => null,
  settingsDateRowAvailable: () => false,
}));
vi.mock("../settings/settings-group", () => ({
  SettingsGroup: () => null,
  SettingsRow: () => null,
  SettingsSwitch: () => null,
}));

const props = { today: "2031-11-23", firstDay: "2031-11-30" };

it("still lets an end be removed where no date picker is available", () => {
  const onChange = vi.fn();
  const group = RoutineEndDate({ ...props, endsOn: "2031-12-24", onChange });
  const [toggle, row] = group ? group.props.children : [];
  expect(row.props).toMatchObject({ title: "Ends", value: "Dec 24, 2031" });
  toggle.props.onChange(false);
  expect(onChange).toHaveBeenCalledWith("");
});

it("offers no end where no date picker is available and none is set", () => {
  expect(RoutineEndDate({ ...props, endsOn: "", onChange: vi.fn() })).toBeNull();
});
