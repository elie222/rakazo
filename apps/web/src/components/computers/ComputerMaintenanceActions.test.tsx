// @vitest-environment jsdom
import type { ComputerStatus, ComputerUpdate } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { computerUpdates } from "../../lib/computers/computer-updates";
import { createQueryRoot as createRoot } from "../../lib/query/query-root.test-support";
import { ComputerMaintenanceActions } from "./ComputerMaintenanceActions";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ConfirmDialog", () => ({
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
const computer = vi.hoisted(() => ({ recover: vi.fn(), reset: vi.fn() }));
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
