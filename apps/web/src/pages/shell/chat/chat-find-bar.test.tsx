// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, createRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatFindBar } from "./chat-find-bar";

let container: HTMLDivElement;
let root: Root;
let scopeElement: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  container = document.createElement("div");
  scopeElement = document.createElement("div");
  scopeElement.innerHTML = '<div data-message-id="m1">hello world</div>';
  document.body.append(container, scopeElement);
  root = createRoot(container);
  const scope = { current: scopeElement };
  act(() =>
    root.render(
      <I18nProvider i18n={i18n}>
        <ChatFindBar scope={scope} inputRef={createRef()} onClose={() => undefined} />
      </I18nProvider>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  scopeElement.remove();
  vi.unstubAllGlobals();
});

function type(value: string) {
  const input = container.querySelector("input") as HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const status = () => container.querySelector("[aria-live]")?.textContent;

it("shows nothing before a query, a position for a match, and No matches when nothing matches", () => {
  expect(status()).toBeUndefined();
  type("world");
  expect(status()).toBe("1/1");
  type("zzz");
  expect(status()).toBe("No matches");
  type("   ");
  expect(status()).toBeUndefined();
});
