// @vitest-environment jsdom

import { flush } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryRoot as createRoot } from "../../lib/query/query-root.test-support";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  // biome-ignore lint/a11y/noLabelWithoutControl: the test does not render the switch it names.
  Label: ({ children, ...props }: ComponentProps<"label">) => <label {...props}>{children}</label>,
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  } & Record<string, unknown>) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      {...props}
    />
  ),
}));

const client = vi.hoisted(() => ({
  spaceSettings: { keepToolCallRecords: vi.fn(), setKeepToolCallRecords: vi.fn() },
}));
vi.mock("../../lib/query/rpc", () => ({
  rpc: client,
  rpcForSpace: () => client,
  createSpaceRpc: () => client,
  selectedSpaceId: () => null,
}));

import { ToolCallRecordsSetting } from "./ToolCallRecordsSetting";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  client.spaceSettings.keepToolCallRecords.mockReset();
  client.spaceSettings.setKeepToolCallRecords.mockReset();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(<ToolCallRecordsSetting />));
  await act(flush);
}

function toggle() {
  return container.querySelector<HTMLButtonElement>("button[role='switch']");
}

describe("ToolCallRecordsSetting", () => {
  it("shows the switch in the Space's current state", async () => {
    client.spaceSettings.keepToolCallRecords.mockImplementation(async () => ({
      keeps: true,
      canManage: true,
    }));
    await render();
    expect(container.textContent).toContain("Keep tool call details");
    expect(container.textContent).toContain("Redacted, and deleted after 14 days");
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
  });

  it("stays out of the way of someone who cannot change it", async () => {
    client.spaceSettings.keepToolCallRecords.mockImplementation(async () => ({
      keeps: true,
      canManage: false,
    }));
    await render();
    expect(toggle()).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("turns the records off for the whole Space", async () => {
    client.spaceSettings.keepToolCallRecords.mockImplementation(async () => ({
      keeps: true,
      canManage: true,
    }));
    client.spaceSettings.setKeepToolCallRecords.mockImplementation(async () => ({ keeps: false }));
    const set = client.spaceSettings.setKeepToolCallRecords;
    await render();
    await act(async () => {
      toggle()?.click();
    });
    await act(flush);
    expect(set).toHaveBeenCalledWith({ keeps: false });
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
  });

  it("says so when the change did not stick", async () => {
    client.spaceSettings.keepToolCallRecords.mockImplementation(async () => ({
      keeps: true,
      canManage: true,
    }));
    client.spaceSettings.setKeepToolCallRecords.mockRejectedValue(
      new Error("Only a Space owner can change this."),
    );
    await render();
    await act(async () => {
      toggle()?.click();
    });
    await act(flush);
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "Only a Space owner can change this.",
    );
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
  });
});
