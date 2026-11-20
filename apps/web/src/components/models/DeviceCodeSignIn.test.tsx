// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  Plural: ({ one, other, value }: { one: string; other: string; value: number }) =>
    value === 1 ? one : other,
}));

import { DeviceCodeSignIn } from "./DeviceCodeSignIn";

const oauth = {
  mode: "device-code" as const,
  loginId: "login",
  provider: "subscription",
  verificationUri: "https://example.test/device",
  userCode: "ABCD-1234",
  expiresInSeconds: 900,
};
let root: Root;
let host: HTMLDivElement;
const onCopyCode = vi.fn();
const onPageOpened = vi.fn();

function render(setup?: { label: string; url: string }) {
  act(() =>
    root.render(
      <DeviceCodeSignIn
        oauth={oauth}
        setup={setup}
        codeCopied={false}
        onCopyCode={onCopyCode}
        onPageOpened={onPageOpened}
      />,
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("copies the code as the same click opens the page to enter it on", () => {
  render();
  const open = [...host.querySelectorAll("a")].find((a) => a.textContent === "Copy code and open");
  expect(open?.getAttribute("href")).toBe(oauth.verificationUri);
  expect(host.textContent).toContain("ABCD-1234");
  open?.addEventListener("click", (event) => event.preventDefault());
  act(() => open?.click());
  expect(onCopyCode).toHaveBeenCalledWith("ABCD-1234");
  expect(onPageOpened).toHaveBeenCalledOnce();
  expect(host.querySelector("ol")).toBeNull();
});

it("puts the provider's setup step before the code", () => {
  render({ label: "Turn on device sign-in", url: "https://example.test/settings" });
  const steps = [...host.querySelectorAll("li")];
  expect(steps).toHaveLength(2);
  expect(steps[0]?.querySelector("a")?.getAttribute("href")).toBe("https://example.test/settings");
  expect(steps[1]?.textContent).toContain("ABCD-1234");
});
