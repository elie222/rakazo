// @vitest-environment jsdom
import type { RakazoDesktop } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listUserDevices, removeUserDevice } from "../lib/user-devices";
import { ComputerDeviceSettings } from "./ComputerDeviceSettings";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Label: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: Omit<ComponentProps<"input">, "onChange"> & {
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      {...props}
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));
vi.mock("../lib/user-devices", () => ({ listUserDevices: vi.fn(), removeUserDevice: vi.fn() }));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.rakazoDesktop;
});

const laptop = { deviceId: "d1", name: "Laptop", connected: true };
const desk = { deviceId: "d2", name: "Desk PC", connected: false };

function desktopWith(device: NonNullable<RakazoDesktop["device"]>) {
  window.rakazoDesktop = { platform: "darwin", device } as RakazoDesktop;
}

it("stays hidden without any computer", async () => {
  vi.mocked(listUserDevices).mockResolvedValue([]);
  await act(async () => root.render(<ComputerDeviceSettings />));
  expect(host.innerHTML).toBe("");
});

it("lists computers with their status and removes one", async () => {
  vi.mocked(listUserDevices).mockResolvedValueOnce([laptop, desk]).mockResolvedValueOnce([laptop]);
  vi.mocked(removeUserDevice).mockResolvedValue();
  await act(async () => root.render(<ComputerDeviceSettings />));
  expect(host.textContent).toContain("LaptopConnected");
  expect(host.textContent).toContain("Desk PCOffline");
  expect(host.querySelector("input")).toBeNull();

  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Remove Desk PC"]')?.click(),
  );
  expect(removeUserDevice).toHaveBeenCalledWith("d2");
  expect(host.textContent).not.toContain("Desk PC");
});

it("turns this computer on and off through the desktop app only", async () => {
  vi.mocked(listUserDevices).mockResolvedValue([]);
  const state = { deviceId: null, name: "Laptop", allowed: false };
  const device = {
    state: vi.fn(async () => state),
    setAllowed: vi.fn(async (allowed: boolean) => {
      Object.assign(state, { allowed, deviceId: "d1" });
      return state;
    }),
  };
  desktopWith(device);
  await act(async () => root.render(<ComputerDeviceSettings />));
  const toggle = host.querySelector<HTMLInputElement>('[data-testid="this-computer-toggle"]')!;
  expect(host.textContent).toContain("Let bots use this computer");
  expect(toggle.checked).toBe(false);

  vi.mocked(listUserDevices).mockResolvedValue([laptop]);
  await act(async () => toggle.click());
  expect(device.setAllowed).toHaveBeenCalledWith(true);
  expect(toggle.checked).toBe(true);
  expect(host.textContent).toContain("LaptopConnected");
});

it("reports a failed removal", async () => {
  vi.mocked(listUserDevices).mockResolvedValue([laptop]);
  vi.mocked(removeUserDevice).mockRejectedValue(new Error("offline"));
  await act(async () => root.render(<ComputerDeviceSettings />));
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Remove Laptop"]')?.click(),
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not remove");
});

it("shows every connected computer as connected", async () => {
  vi.mocked(listUserDevices).mockResolvedValue([laptop, { ...desk, connected: true }]);
  await act(async () => root.render(<ComputerDeviceSettings />));
  expect(host.textContent).toContain("LaptopConnected");
  expect(host.textContent).toContain("Desk PCConnected");
});

it("stays off and reports it when turning this computer on fails", async () => {
  vi.mocked(listUserDevices).mockResolvedValue([]);
  const device = {
    state: vi.fn(async () => ({ deviceId: null, name: "Laptop", allowed: false })),
    setAllowed: vi.fn(async () => {
      throw new Error("Could not pair this computer");
    }),
  };
  desktopWith(device);
  await act(async () => root.render(<ComputerDeviceSettings />));
  const toggle = host.querySelector<HTMLInputElement>('[data-testid="this-computer-toggle"]')!;
  await act(async () => toggle.click());
  expect(device.setAllowed).toHaveBeenCalledWith(true);
  expect(toggle.checked).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not change");
});
