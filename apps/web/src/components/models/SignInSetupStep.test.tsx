// @vitest-environment jsdom

import { useSignInSetup } from "@rakazo/chat-ui/sign-in-setup";
import type { ModelCatalogEntry } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
}));

import { SignInSetupStep } from "./SignInSetupStep";

const setup = {
  label: "Turn on device sign-in",
  url: "https://example.test/settings",
  note: "Some accounts need an admin.",
};
let root: Root;
let host: HTMLDivElement;
const start = vi.fn();

function Harness({
  entrySetup,
  provider = "subscription",
}: {
  entrySetup: ModelCatalogEntry["signInSetup"];
  provider?: string;
}) {
  const signIn = useSignInSetup(entrySetup, provider, start);
  return signIn.setup ? (
    <SignInSetupStep setup={signIn.setup} onContinue={signIn.proceed} onCancel={signIn.dismiss} />
  ) : (
    <button type="button" onClick={signIn.begin}>
      Sign in
    </button>
  );
}

function render(entrySetup: ModelCatalogEntry["signInSetup"], provider?: string) {
  act(() => root.render(<Harness entrySetup={entrySetup} provider={provider} />));
}

function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(button).toBeDefined();
  act(() => button?.click());
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

it("shows the required setting before the sign-in starts", () => {
  render(setup);
  click("Sign in");
  expect(start).not.toHaveBeenCalled();
  expect(host.querySelector("a")?.getAttribute("href")).toBe(setup.url);
  expect(host.textContent).toContain(setup.note);
  click("I’ve turned it on");
  expect(start).toHaveBeenCalledOnce();
  expect(host.textContent).toBe("Sign in");
});

it("goes back without starting when the setting step is cancelled", () => {
  render(setup);
  click("Sign in");
  click("Cancel");
  expect(start).not.toHaveBeenCalled();
  expect(host.textContent).toBe("Sign in");
});

it("starts at once when the provider needs no setting", () => {
  render(undefined);
  click("Sign in");
  expect(start).toHaveBeenCalledOnce();
});

it("closes the step when another provider is chosen, so returning does not reopen it", () => {
  render(setup);
  click("Sign in");
  render(setup, "another");
  render(setup);
  expect(host.textContent).toBe("Sign in");
});
