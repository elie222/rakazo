// @vitest-environment jsdom

import type { ChangeEvent, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceRow } from "./bot-settings-sections";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  OptionSelect: ({
    value,
    options,
    onValueChange,
    disabled,
    "aria-label": label,
    "data-testid": testId,
  }: {
    value: string | null;
    options: ReadonlyArray<{ value: string; label: string }>;
    onValueChange: (value: string) => void;
    disabled?: boolean;
    "aria-label"?: string;
    "data-testid"?: string;
  }) => (
    <select
      aria-label={label}
      data-testid={testId}
      value={value ?? ""}
      disabled={disabled}
      onChange={(event: ChangeEvent<HTMLSelectElement>) => onValueChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const devices = [
  { deviceId: "d1", name: "Laptop", connected: true },
  { deviceId: "d2", name: "Desk PC", connected: false },
];

const roots: Array<{ unmount: () => void }> = [];
afterEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  roots.splice(0).forEach((root) => {
    act(() => root.unmount());
  });
  document.body.innerHTML = "";
});

function renderRow(value: string | null, boundName?: string, onChange = vi.fn()) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <DeviceRow
        id="devices"
        value={value}
        devices={devices}
        boundName={boundName}
        onChange={onChange}
      />,
    );
  });
  roots.push(root);
  const select = container.querySelector<HTMLSelectElement>('[data-testid="bot-host-device"]')!;
  const optionLabels = [...select.options].map((option) => option.textContent);
  /** Play the parent applying a confirmed save back onto the row. */
  const confirm = (next: string | null) =>
    act(() => {
      root.render(
        <DeviceRow
          id="devices"
          value={next}
          devices={devices}
          boundName={boundName}
          onChange={onChange}
        />,
      );
    });
  return { select, onChange, optionLabels, confirm };
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("DeviceRow", () => {
  it("offers any connected computer and each paired one", () => {
    const { optionLabels } = renderRow(null);
    expect(optionLabels).toEqual(["Any connected computer", "Laptop", "Desk PC (offline)"]);
  });

  it("binds a chosen computer and clears back to any", async () => {
    const { select, onChange, confirm } = renderRow(null);
    await choose(select, "d1");
    expect(onChange).toHaveBeenCalledWith("d1");
    confirm("d1");
    await choose(select, "");
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("names a bound computer that is no longer paired", () => {
    const { select, optionLabels } = renderRow("gone", "Old PC");
    expect(select.value).toBe("gone");
    expect(optionLabels.at(-1)).toBe("Old PC (offline)");
  });
});
