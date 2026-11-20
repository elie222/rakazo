// @vitest-environment jsdom

import type { ModelCatalogEntry } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
}));

import { useSignInSetup } from "../../lib/models/use-sign-in-setup";
import { SignInSetupStep } from "./SignInSetupStep";

const setup = {
  label: "Turn on device sign-in",
  url: "https://example.test/settings",
  note: "Some accounts need an admin.",
};
let root: Root;
let host: HTMLDivElement;
const start = vi.fn();

function Harness({ entrySetup }: { entrySetup: ModelCatalogEntry["signInSetup"] }) {
  const signIn = useSignInSetup(entrySetup, "subscription", start);
  return signIn.setup ? (
    <SignInSetupStep setup={signIn.setup} onContinue={signIn.proceed} onCancel={signIn.dismiss} />
  ) : (
    <button type="button" onClick={signIn.begin}>
      Sign in
    </button>
  );
}

function render(entrySetup: ModelCatalogEntry["signInSetup"]) {
  act(() => root.render(<Harness entrySetup={entrySetup} />));
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
