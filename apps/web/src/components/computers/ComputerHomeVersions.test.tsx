// @vitest-environment jsdom
import { COMPUTER_RUNNING_ERROR } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
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
  document.body.append(host);
  root = createRoot(host, new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  computer.homeVersions.mockReset().mockResolvedValue(versions);
  computer.restoreHomeVersion.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = async () => {
  await act(async () => root.render(<ComputerHomeVersions botId="bot-1" />));
  await vi.waitFor(() => expect(host.querySelector("button")).not.toBeNull());
};
const click = (label: string) =>
  act(async () =>
    [...host.querySelectorAll("button")].find((button) => button.textContent === label)?.click(),
  );
const retry = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry");
const renderFailed = async () => {
  await act(async () => root.render(<ComputerHomeVersions botId="bot-1" />));
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not load"),
  );
};

it("shows nothing until the computer has an earlier version", async () => {
  computer.homeVersions.mockResolvedValue([]);
  await act(async () => root.render(<ComputerHomeVersions botId="bot-1" />));
  await vi.waitFor(() => expect(computer.homeVersions).toHaveBeenCalled());
  expect(host.textContent).toBe("");
});

it("says when the versions could not be read and offers Retry", async () => {
  computer.homeVersions.mockRejectedValue(new Error("storage down"));
  await act(async () => root.render(<ComputerHomeVersions botId="bot-1" />));
  await vi.waitFor(() => expect(retry()).toBeDefined());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not load");
});

it("reads the versions again on Retry and restores once the read succeeds", async () => {
  computer.homeVersions.mockRejectedValueOnce(new Error("storage down"));
  await renderFailed();
  await click("Retry");

  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toBe(""));
  expect(computer.homeVersions).toHaveBeenCalledTimes(2);
  expect(host.querySelector("button")?.textContent).toBe("Restore earlier version");
});

it("keeps focus and announces each failure without allowing duplicate retries", async () => {
  const initial = deferred<typeof versions>();
  computer.homeVersions.mockReturnValueOnce(initial.promise);
  await act(async () => root.render(<ComputerHomeVersions botId="bot-1" />));
  const alert = host.querySelector('[role="alert"]');
  expect(alert).not.toBeNull();
  expect(alert?.textContent).toBe("");
  await act(async () => initial.reject(new Error("storage down")));
  await vi.waitFor(() => expect(alert?.textContent).toBe("Could not load"));

  const next = deferred<typeof versions>();
  computer.homeVersions.mockReturnValueOnce(next.promise);
  retry()?.focus();
  await click("Retry");

  await vi.waitFor(() => expect(retry()?.getAttribute("aria-disabled")).toBe("true"));
  expect(document.activeElement).toBe(retry());
  expect(host.querySelector('[role="alert"]')).toBe(alert);
  expect(alert?.textContent).toBe("");
  await click("Retry");
  expect(computer.homeVersions).toHaveBeenCalledTimes(2);

  await act(async () => next.reject(new Error("storage still down")));
  await vi.waitFor(() => expect(alert?.textContent).toBe("Could not load"));
  expect(host.querySelector('[role="alert"]')).toBe(alert);
  expect(retry()?.getAttribute("aria-disabled")).toBe("false");
  expect(document.activeElement).toBe(retry());
  await click("Retry");
  await vi.waitFor(() =>
    expect(host.querySelector("button")?.textContent).toBe("Restore earlier version"),
  );
  expect(alert?.textContent).toBe("");
  expect(computer.homeVersions).toHaveBeenCalledTimes(3);
});

it("hides the row when a retry returns no saved versions", async () => {
  computer.homeVersions.mockRejectedValueOnce(new Error("storage down")).mockResolvedValue([]);
  await renderFailed();
  await click("Retry");
  await vi.waitFor(() => expect(host.textContent).toBe(""));
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
    expect(host.querySelector('[data-testid="confirm"] [role="alert"]')?.textContent).toBe(
      "Stop the computer first.",
    ),
  );
  expect(computer.restoreHomeVersion).toHaveBeenCalledWith({ botId: "bot-1", versionId: "rev-2" });
});
