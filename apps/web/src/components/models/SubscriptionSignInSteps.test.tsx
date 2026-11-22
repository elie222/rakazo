// @vitest-environment jsdom

import type { ModelOAuthBegin } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  Plural: ({ one, other, value }: { one: string; other: string; value: number }) =>
    (value === 1 ? one : other).replace("#", String(value)),
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

import { SubscriptionSignInSteps } from "./SubscriptionSignInSteps";

const deviceCode: ModelOAuthBegin = {
  mode: "device-code",
  loginId: "login",
  provider: "subscription",
  verificationUri: "https://example.test/device",
  userCode: "ABCD-1234",
  expiresInSeconds: 900,
};
const pasteBack: ModelOAuthBegin = {
  mode: "auth-url",
  loginId: "login",
  provider: "subscription",
  verificationUri: "https://example.test/oauth/authorize?state=abc",
  expiresInSeconds: 900,
};
const setup = {
  label: "Turn on device sign-in",
  url: "https://example.test/settings",
  note: "An admin turns this on for workspaces.",
};
let root: Root;
let host: HTMLDivElement;
const onStart = vi.fn();
const onRestart = vi.fn();
const onCopyCode = vi.fn();
const onSubmitCode = vi.fn();
const onPageOpened = vi.fn();

function render(
  oauth: ModelOAuthBegin | null,
  options: { setup?: typeof setup; pasteCode?: string } = {},
) {
  act(() =>
    root.render(
      <SubscriptionSignInSteps
        oauth={oauth}
        setup={options.setup}
        startLabel="Sign in"
        starting={false}
        onStart={onStart}
        onRestart={onRestart}
        codeCopied={false}
        onCopyCode={onCopyCode}
        pasteCode={options.pasteCode ?? ""}
        onPasteCodeChange={vi.fn()}
        onSubmitCode={onSubmitCode}
        onPageOpened={onPageOpened}
      />,
    ),
  );
}

const link = (text: string) => [...host.querySelectorAll("a")].find((a) => a.textContent === text);
const steps = () => [...host.querySelectorAll("li")];

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

it("is just the start button when the provider needs nothing first", () => {
  render(null);
  expect(steps()).toHaveLength(0);
  act(() => host.querySelector("button")?.click());
  expect(onStart).toHaveBeenCalledOnce();
});

it("puts the provider's setup before starting, and marks it done once a code arrives", () => {
  render(null, { setup });
  expect(steps().map((step) => step.dataset.status)).toEqual(["current", "upcoming"]);
  expect(link("Open settings")?.getAttribute("href")).toBe(setup.url);
  expect(steps()[0]?.textContent).toContain(setup.note);
  render(deviceCode, { setup });
  expect(steps().map((step) => step.dataset.status)).toEqual(["complete", "current", "upcoming"]);
});

it("copies a device code as the same click opens the page to enter it on", () => {
  render(deviceCode);
  expect(host.textContent).toContain("ABCD-1234");
  expect(host.textContent).toContain("The code expires in about 15 minutes.");
  const open = link("Copy code and open");
  expect(open?.getAttribute("href")).toBe(deviceCode.verificationUri);
  open?.addEventListener("click", (event) => event.preventDefault());
  act(() => open?.click());
  expect(onCopyCode).toHaveBeenCalledWith("ABCD-1234");
  expect(onPageOpened).toHaveBeenCalledOnce();
});

it("opens a paste-back sign-in page from the click and submits only a pasted code", () => {
  render(pasteBack, { pasteCode: " " });
  const open = link("Open example.test");
  expect(open?.getAttribute("href")).toBe(pasteBack.verificationUri);
  expect(open?.rel).toBe("noreferrer");
  open?.addEventListener("click", (event) => event.preventDefault());
  act(() => open?.click());
  expect(onPageOpened).toHaveBeenCalledOnce();
  const submit = [...host.querySelectorAll("button")].find((b) => b.textContent === "Submit");
  expect(submit?.disabled).toBe(true);
  render(pasteBack, { pasteCode: "code#state" });
  act(() => submit?.click());
  expect(onSubmitCode).toHaveBeenCalledOnce();
});

it("starts a new sign-in from either kind once one is under way", () => {
  render(deviceCode);
  act(() =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Get a new code")?.click(),
  );
  render(pasteBack);
  act(() =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Start over")?.click(),
  );
  expect(onRestart).toHaveBeenCalledTimes(2);
});
