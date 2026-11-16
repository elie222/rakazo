// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { RakazoDesktop } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../lib/rpc";
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
vi.mock("../lib/rpc", () => ({ rpc: { me: vi.fn() } }));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const initialDocument = window.location.href;

function pointDocumentAt(url: string) {
  const dom = (globalThis as { jsdom?: { reconfigure: (settings: { url: string }) => void } })
    .jsdom;
  if (!dom) throw new Error("Expected the jsdom environment");
  dom.reconfigure({ url });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.rakazoDesktop;
  if (window.location.href !== initialDocument) pointDocumentAt(initialDocument);
  vi.unstubAllGlobals();
});

const laptop = { deviceId: "d1", name: "Laptop", connected: true };
const desk = { deviceId: "d2", name: "Desk PC", connected: false };

function desktopWith(device: NonNullable<RakazoDesktop["device"]>) {
  window.rakazoDesktop = { platform: "darwin", device } as RakazoDesktop;
}

/** The web build compiles macros onto the real hook, which throws without this provider. */
function renderSettings() {
  return act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <ComputerDeviceSettings />
      </I18nProvider>,
    ),
  );
}

it("stays hidden without any computer", async () => {
  vi.mocked(listUserDevices).mockResolvedValue([]);
  await renderSettings();
  expect(host.innerHTML).toBe("");
});

it("lists computers with their status and removes one", async () => {
  vi.mocked(listUserDevices).mockResolvedValueOnce([laptop, desk]).mockResolvedValueOnce([laptop]);
  vi.mocked(removeUserDevice).mockResolvedValue();
  await renderSettings();
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
  await renderSettings();
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
  await renderSettings();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Remove Laptop"]')?.click(),
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not remove");
});

it("shows every connected computer as connected", async () => {
  vi.mocked(listUserDevices).mockResolvedValue([laptop, { ...desk, connected: true }]);
  await renderSettings();
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
  await renderSettings();
  const toggle = host.querySelector<HTMLInputElement>('[data-testid="this-computer-toggle"]')!;
  await act(async () => toggle.click());
  expect(device.setAllowed).toHaveBeenCalledWith(true);
  expect(toggle.checked).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not change");
});

it("turns this computer on and off for the app-managed local server", async () => {
  vi.mocked(listUserDevices).mockResolvedValue([]);
  const me = { canChooseHostComputer: true, computerHost: "docker" };
  vi.mocked(rpc.me).mockImplementation(async () => me as Awaited<ReturnType<typeof rpc.me>>);
  const computer = {
    managesHostChoice: true,
    requestAccess: vi.fn(async () => {
      me.computerHost = "this-mac";
      return true;
    }),
    revokeAccess: vi.fn(async () => {
      me.computerHost = "docker";
    }),
    onConfigure: () => () => undefined,
  };
  window.rakazoDesktop = {
    platform: "darwin",
    computer,
    device: { state: async () => null, setAllowed: vi.fn() },
  } as unknown as RakazoDesktop;
  await renderSettings();
  const toggle = host.querySelector<HTMLInputElement>('[data-testid="this-computer-toggle"]')!;
  expect(toggle.checked).toBe(false);

  await act(async () => toggle.click());
  expect(computer.requestAccess).toHaveBeenCalled();
  expect(toggle.checked).toBe(true);

  await act(async () => toggle.click());
  expect(computer.revokeAccess).toHaveBeenCalled();
  expect(toggle.checked).toBe(false);
});

it("stays hidden on a server that does not run bots on this computer", async () => {
  vi.mocked(listUserDevices).mockResolvedValue([]);
  vi.mocked(rpc.me).mockResolvedValue({
    canChooseHostComputer: false,
    computerHost: null,
  } as Awaited<ReturnType<typeof rpc.me>>);
  window.rakazoDesktop = {
    platform: "darwin",
    computer: { managesHostChoice: true },
    device: { state: async () => null },
  } as unknown as RakazoDesktop;
  await renderSettings();
  expect(host.innerHTML).toBe("");
});

it("keeps the local switch when a later profile read fails", async () => {
  vi.mocked(listUserDevices).mockResolvedValue([]);
  vi.mocked(rpc.me)
    .mockResolvedValueOnce({ canChooseHostComputer: true, computerHost: "this-mac" } as Awaited<
      ReturnType<typeof rpc.me>
    >)
    .mockRejectedValue(new Error("offline"));
  const computer = {
    managesHostChoice: true,
    requestAccess: vi.fn(async () => true),
    revokeAccess: vi.fn(async () => {
      throw new Error("Local server is unavailable");
    }),
    onConfigure: () => () => undefined,
  };
  window.rakazoDesktop = {
    platform: "darwin",
    computer,
    device: { state: async () => null, setAllowed: vi.fn() },
  } as unknown as RakazoDesktop;
  await renderSettings();
  await act(async () =>
    host.querySelector<HTMLInputElement>('[data-testid="this-computer-toggle"]')!.click(),
  );
  const toggle = host.querySelector<HTMLInputElement>('[data-testid="this-computer-toggle"]');
  expect(toggle?.checked).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not change");
});

it("explains that plain HTTP does not pair this computer", async () => {
  pointDocumentAt("http://192.168.1.20:5173/");
  vi.mocked(listUserDevices).mockResolvedValue([]);
  const setAllowed = vi.fn();
  desktopWith({ state: async () => null, setAllowed });
  await renderSettings();
  expect(host.querySelector('[data-testid="computer-devices"]')).not.toBeNull();
  expect(host.textContent).toContain("Plain HTTP does not pair");
  expect(host.querySelector('[data-testid="this-computer-toggle"]')).toBeNull();
  expect(setAllowed).not.toHaveBeenCalled();
});

it("explains plain HTTP next to another computer without a switch", async () => {
  pointDocumentAt("http://192.168.1.20:5173/");
  vi.mocked(listUserDevices).mockResolvedValue([laptop]);
  const setAllowed = vi.fn();
  desktopWith({ state: async () => null, setAllowed });
  await renderSettings();
  expect(host.textContent).toContain("Plain HTTP does not pair");
  expect(host.textContent).toContain("LaptopConnected");
  expect(host.querySelector('[data-testid="this-computer-toggle"]')).toBeNull();
  expect(setAllowed).not.toHaveBeenCalled();
});

it("stays hidden in a browser on plain HTTP", async () => {
  pointDocumentAt("http://192.168.1.20:5173/");
  vi.mocked(listUserDevices).mockResolvedValue([]);
  await renderSettings();
  expect(host.innerHTML).toBe("");
});
