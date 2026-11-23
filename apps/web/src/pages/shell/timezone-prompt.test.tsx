// @vitest-environment jsdom

import type { Me } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { keptTimezones } from "../../lib/locale/kept-timezone";
import { createQueryRoot } from "../../lib/query/query-root.test-support";
import { TimezonePrompt } from "./timezone-prompt";

const device = vi.hoisted(() => ({ zone: "Asia/Tokyo" }));
vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/core")>()),
  localTimezone: () => device.zone,
}));
const rpc = vi.hoisted(() => ({
  usage: { breakdown: vi.fn() },
  preferences: {
    update: vi.fn(async ({ timezone }: { timezone: string }) => ({ timezone }) as Me),
    adoptTimezone: vi.fn(async ({ timezone }: { timezone: string }) => ({ timezone }) as Me),
  },
}));
vi.mock("../../lib/query/rpc", () => ({
  rpc,
  rpcForSpace: () => rpc,
  createSpaceRpc: () => rpc,
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

let root: ReturnType<typeof createQueryRoot>;
const onSaved = vi.fn();

async function show(timezone: string | null) {
  await act(async () =>
    root.render(<TimezonePrompt userId="user-1" timezone={timezone} onSaved={onSaved} />),
  );
}

const prompt = () => document.querySelector('[data-testid="timezone-prompt"]');
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((node) => node.textContent === name);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  device.zone = "Asia/Tokyo";
  root = createQueryRoot(document.body.appendChild(document.createElement("div")));
});

afterEach(async () => {
  await act(async () => root.unmount());
  keptTimezones.set({});
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("adopts the device zone for an account without one, without asking", async () => {
  await show(null);
  expect(rpc.preferences.adoptTimezone).toHaveBeenCalledWith({ timezone: "Asia/Tokyo" });
  expect(prompt()).toBeNull();
});

it("asks nothing while the account uses the device zone", async () => {
  await show("Asia/Tokyo");
  expect(prompt()).toBeNull();
});

it("switches the account to the device zone", async () => {
  await show("Europe/London");
  expect(prompt()?.textContent).toContain("Switch to Tokyo time?");
  await act(async () => button("Switch")?.click());
  expect(rpc.preferences.update).toHaveBeenCalledWith({ timezone: "Asia/Tokyo" });
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith({ timezone: "Asia/Tokyo" }));
});

it("remembers Keep for this device zone and asks again once the device moves", async () => {
  await show("Europe/London");
  await act(async () => button("Keep")?.click());
  expect(keptTimezones.get()).toEqual({
    "user-1": { device: "Asia/Tokyo", account: "Europe/London" },
  });
  await vi.waitFor(() => expect(prompt()).toBeNull());
  expect(rpc.preferences.update).not.toHaveBeenCalled();

  device.zone = "America/New_York";
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(prompt()?.textContent).toContain("Switch to New York time?");
});
