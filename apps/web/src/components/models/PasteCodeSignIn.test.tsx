// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

import { PasteCodeSignIn } from "./PasteCodeSignIn";

const oauth = {
  mode: "auth-url" as const,
  loginId: "login",
  provider: "subscription",
  verificationUri: "https://example.test/oauth/authorize?state=abc",
  expiresInSeconds: 900,
};
let root: Root;
let host: HTMLDivElement;
const onSubmit = vi.fn();
const onPageOpened = vi.fn();

function render(code: string) {
  act(() =>
    root.render(
      <PasteCodeSignIn
        oauth={oauth}
        code={code}
        onCodeChange={vi.fn()}
        onSubmit={onSubmit}
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

it("opens the sign-in page from the person's own click and reports only that", () => {
  render("");
  expect(onPageOpened).not.toHaveBeenCalled();
  const open = host.querySelector("a");
  expect(open?.textContent).toBe("Open example.test");
  expect(open?.getAttribute("href")).toBe(oauth.verificationUri);
  expect(open?.target).toBe("_blank");
  expect(open?.rel).toBe("noreferrer");
  open?.addEventListener("click", (event) => event.preventDefault());
  act(() => open?.click());
  expect(onPageOpened).toHaveBeenCalledOnce();
});

it("submits a pasted code but not an empty one", () => {
  render(" ");
  const submit = host.querySelector("button");
  expect(submit?.disabled).toBe(true);
  render("code#state");
  act(() => submit?.click());
  expect(onSubmit).toHaveBeenCalledOnce();
});
