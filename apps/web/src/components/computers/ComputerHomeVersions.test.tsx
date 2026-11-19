// @vitest-environment jsdom
import { COMPUTER_RUNNING_ERROR } from "@rakazo/contracts";
import { QueryClient } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQueryRoot as createRoot } from "../../lib/query/query-root.test-support";
import { ComputerHomeVersions } from "./ComputerHomeVersions";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  RadioGroup: ({
    children,
    onValueChange,
  }: {
    children: ReactNode;
    onValueChange: (value: string) => void;
  }) => (
    // biome-ignore lint/a11y/noStaticElementInteractions: a test double for the radio group.
    // biome-ignore lint/a11y/useKeyWithClickEvents: a test double for the radio group.
    <div
      onClick={(event) => {
        const value = (event.target as HTMLElement).dataset.value;
        if (value) onValueChange(value);
      }}
    >
      {children}
    </div>
  ),
  RadioGroupItem: ({ value }: { value: string }) => <input type="radio" data-value={value} />,
}));
vi.mock("../ConfirmDialog", () => ({
  ConfirmDialog: (props: {
    open: boolean;
    error: string | null;
    children: ReactNode;
    onConfirm: () => void;
  }) =>
    props.open ? (
      <div data-testid="confirm">
        {props.children}
        {props.error ? <p role="alert">{props.error}</p> : null}
        <button type="button" onClick={props.onConfirm}>
          Confirm
        </button>
      </div>
    ) : null,
}));
const computer = vi.hoisted(() => ({ homeVersions: vi.fn(), restoreHomeVersion: vi.fn() }));
vi.mock("../../lib/query/rpc", () => {
  const rpc = { computer };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => null,
    SPACE_SELECTED_EVENT: "space-selected",
  };
});

const versions = [
  { id: "rev-2", savedAt: "2026-11-19T10:00:00.000Z" },
  { id: "rev-1", savedAt: "2026-11-18T10:00:00.000Z" },
];

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement("div");
  root = createRoot(host, new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  computer.homeVersions.mockReset().mockResolvedValue(versions);
  computer.restoreHomeVersion.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => act(() => root.unmount()));

const render = async () => {
  await act(async () => root.render(<ComputerHomeVersions botId="bot-1" />));
  await vi.waitFor(() => expect(host.querySelector("button")).not.toBeNull());
};
const click = (label: string) =>
  act(async () =>
    [...host.querySelectorAll("button")].find((button) => button.textContent === label)?.click(),
  );

it("shows nothing until the computer has an earlier version", async () => {
  computer.homeVersions.mockResolvedValue([]);
  await act(async () => root.render(<ComputerHomeVersions botId="bot-1" />));
  await vi.waitFor(() => expect(computer.homeVersions).toHaveBeenCalled());
  expect(host.textContent).toBe("");
});

it("says when the versions could not be read", async () => {
  computer.homeVersions.mockRejectedValue(new Error("storage down"));
  await act(async () => root.render(<ComputerHomeVersions botId="bot-1" />));
  await vi.waitFor(() => expect(host.textContent).toBe("Computer filesCould not load"));
  expect(host.querySelector("button")).toBeNull();
});

it("restores the chosen version and reads the versions again", async () => {
  await render();
  await click("Restore earlier version");
  expect(host.querySelectorAll("input[type=radio]")).toHaveLength(2);
  await act(async () => (host.querySelector('[data-value="rev-1"]') as HTMLElement).click());
  await click("Confirm");

  await vi.waitFor(() => expect(host.querySelector('[data-testid="confirm"]')).toBeNull());
  expect(computer.restoreHomeVersion).toHaveBeenCalledWith({ botId: "bot-1", versionId: "rev-1" });
  expect(computer.homeVersions).toHaveBeenCalledTimes(2);
});

it("asks to stop a running computer first", async () => {
  computer.restoreHomeVersion.mockRejectedValue(
    Object.assign(new Error("Stop the computer"), { code: COMPUTER_RUNNING_ERROR }),
  );
  await render();
  await click("Restore earlier version");
  await click("Confirm");

  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Stop the computer first."),
  );
  expect(computer.restoreHomeVersion).toHaveBeenCalledWith({ botId: "bot-1", versionId: "rev-2" });
});
