// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { OptionSelect } from "./option-select.js";

function Harness() {
  const [value, setValue] = useState("");
  return (
    <>
      <OptionSelect
        aria-label="Model"
        value={value}
        options={[
          { value: "", label: "Default" },
          { value: "a", label: "Alpha" },
        ]}
        onValueChange={setValue}
      />
      <output>{`[${value}]`}</output>
    </>
  );
}

async function choose(label: string) {
  const trigger = document.querySelector<HTMLElement>('[role="combobox"]');
  await act(async () => trigger?.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (entry) => entry.textContent === label,
  );
  await act(async () => option?.click());
}

it("shows and picks an option whose value is empty", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    const trigger = () => document.querySelector('[role="combobox"]')?.textContent;
    const output = () => document.querySelector("output")?.textContent;
    expect(trigger()).toContain("Default");
    await choose("Alpha");
    expect(output()).toBe("[a]");
    expect(trigger()).toContain("Alpha");
    await choose("Default");
    expect(output()).toBe("[]");
    expect(trigger()).toContain("Default");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
