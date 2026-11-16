// @vitest-environment jsdom
import type { ComputerStatus } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComputerMaintenanceActions } from "./ComputerMaintenanceActions";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("./ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("../lib/computer-updates", () => ({ computerUpdates: { start: vi.fn() } }));
vi.mock("../lib/rpc", () => ({ rpc: { computer: { reset: vi.fn() } } }));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

const status = (botId: string, extra: Partial<ComputerStatus> = {}) =>
  ({ botId, state: "running", canUpdate: true, busyBotName: null, ...extra }) as ComputerStatus;
const render = (computer: ComputerStatus) =>
  act(() =>
    root.render(
      <ComputerMaintenanceActions
        botId="bot-settings"
        computer={computer}
        onChanged={async () => {}}
      />,
    ),
  );
const labels = () => [...host.querySelectorAll("button")].map((button) => button.textContent);

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
