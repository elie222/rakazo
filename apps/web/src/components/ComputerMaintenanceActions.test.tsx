// @vitest-environment jsdom
import type { ComputerStatus, ComputerUpdate } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { computerUpdates } from "../lib/computer-updates";
import { createQueryRoot as createRoot } from "../lib/query-root.test-support";
import { ComputerMaintenanceActions } from "./ComputerMaintenanceActions";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("./ConfirmDialog", () => ({
  ConfirmDialog: (props: {
    open: boolean;
    error: string | null;
    confirmDisabled: boolean;
    onConfirm: () => void;
  }) =>
    props.open ? (
      <div data-testid="confirm">
        {props.error ? <p role="alert">{props.error}</p> : null}
        <button type="button" disabled={props.confirmDisabled} onClick={props.onConfirm}>
          Confirm
        </button>
      </div>
    ) : null,
}));
const computer = vi.hoisted(() => ({
  recover: vi.fn(),
  reset: vi.fn(),
  restartScreen: vi.fn(),
}));
vi.mock("../lib/rpc", () => {
  const rpc = { computer };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => null,
    SPACE_SELECTED_EVENT: "space-selected",
  };
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

const status = (botId: string, extra: Partial<ComputerStatus> = {}) =>
  ({ botId, state: "running", canUpdate: true, busyBotName: null, ...extra }) as ComputerStatus;
const render = (status: ComputerStatus, onChanged: () => Promise<void> = async () => {}) =>
  act(() =>
    root.render(
      <ComputerMaintenanceActions botId="bot-settings" computer={status} onChanged={onChanged} />,
    ),
  );
const labels = () => [...host.querySelectorAll("button")].map((button) => button.textContent);
const click = (label: string) =>
  act(async () =>
    [...host.querySelectorAll("button")].find((button) => button.textContent === label)?.click(),
  );

it("offers Recover for a computer that can update in place", async () => {
  await render(status("bot-settings"));
  expect(labels()).toEqual(["Recover computer"]);
});

it("offers Reset for a computer that cannot update in place", async () => {
  await render(status("bot-settings", { canUpdate: false }));
  expect(labels()).toEqual(["Reset computer"]);
});

it("offers nothing while the computer is booting", async () => {
  await render(status("bot-settings", { state: "booting" }));
  expect(labels()).toEqual([]);
});

it("hides the rows when the shared status belongs to another bot's computer", async () => {
  await render(status("bot-peer"));
  expect(labels()).toEqual([]);
});

it("offers Restart screen only for a running Team computer whose kind supports it", async () => {
  await render(status("bot-settings", { mode: "team", canRestartScreen: true }));
  expect(labels()).toEqual(["Recover computer", "Restart screen"]);

  await render(status("bot-settings", { mode: "dedicated", canRestartScreen: true }));
  expect(labels()).toEqual(["Recover computer"]);

  await render(status("bot-settings", { mode: "team", state: "stopped", canRestartScreen: true }));
  expect(labels()).toEqual(["Recover computer"]);

  await render(status("bot-settings", { mode: "team" }));
  expect(labels()).toEqual(["Recover computer"]);

  await render(status("bot-peer", { mode: "team", canRestartScreen: true }));
  expect(labels()).toEqual([]);
});

it("does not offer Restart screen while someone else controls the computer", async () => {
  await render(
    status("bot-settings", { mode: "team", canRestartScreen: true, controlledByOther: true }),
  );
  expect(labels()).toEqual(["Recover computer"]);
});

it("holds Restart screen while this bot is working", async () => {
  await render(
    status("bot-settings", { mode: "team", busyBotName: "Settings bot", canRestartScreen: true }),
  );
  const button = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Restart screen",
  );
  expect(button?.disabled).toBe(true);
});

it("holds Restart screen while this bot waits for a person to take over", async () => {
  await render(
    status("bot-settings", { mode: "team", takeoverRequested: true, canRestartScreen: true }),
  );
  const button = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Restart screen",
  );
  expect(button?.disabled).toBe(true);
});

it("restarts only this bot's screen, without recovering or resetting the computer", async () => {
  computer.restartScreen.mockResolvedValueOnce({});
  const onChanged = vi.fn(async () => {});
  await render(status("bot-settings", { mode: "team", canRestartScreen: true }), onChanged);
  await click("Restart screen");
  await click("Confirm");
  expect(computer.restartScreen).toHaveBeenCalledExactlyOnceWith({ botId: "bot-settings" });
  expect(computer.recover).not.toHaveBeenCalled();
  expect(computer.reset).not.toHaveBeenCalled();
  expect(onChanged).toHaveBeenCalledOnce();
  expect(host.querySelector('[data-testid="confirm"]')).toBeNull();
});

it("keeps the confirmation open with the reason when the screen restart is refused", async () => {
  computer.restartScreen.mockRejectedValueOnce(
    new Error("This bot is working or waiting. Stop it, then try again"),
  );
  await render(status("bot-settings", { mode: "team", canRestartScreen: true }));
  await click("Restart screen");
  await click("Confirm");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "This bot is working or waiting. Stop it, then try again",
  );
});

const recovery = { id: "update-recover", action: "recover" } as ComputerUpdate;

it("recovers once, holding the controls until the computer is read again", async () => {
  const recovered = deferred<ComputerUpdate>();
  computer.recover.mockReturnValueOnce(recovered.promise);
  const onChanged = vi.fn(async () => {});
  await render(status("bot-settings"), onChanged);
  await click("Recover computer");
  await act(async () => {
    const confirm = [...host.querySelectorAll("button")].find((b) => b.textContent === "Confirm");
    confirm?.click();
    confirm?.click();
  });
  expect(computer.recover).toHaveBeenCalledExactlyOnceWith({ botId: "bot-settings" });
  expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);

  await act(async () => recovered.resolve(recovery));
  expect(onChanged).toHaveBeenCalledOnce();
  expect(host.querySelector('[data-testid="confirm"]')).toBeNull();
  expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
});

it("opens the progress of the recovery it starts", async () => {
  computer.recover.mockResolvedValueOnce(recovery);
  await render(status("bot-settings"));
  await click("Recover computer");
  await click("Confirm");
  expect(computerUpdates.getSnapshot()).toMatchObject({
    updates: [recovery],
    openId: "update-recover",
  });
});

it("keeps the confirmation open with the reason when the reset fails", async () => {
  computer.reset.mockRejectedValueOnce(new Error("Computer is busy"));
  await render(status("bot-settings", { canUpdate: false }));
  await click("Reset computer");
  await click("Confirm");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Computer is busy");
  expect(host.querySelector<HTMLButtonElement>('[data-testid="confirm"] button')?.disabled).toBe(
    false,
  );
});
