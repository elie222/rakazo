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
let outside: HTMLButtonElement;
const onClose = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  onClose.mockReset();
  container = document.createElement("div");
  outside = document.createElement("button");
  document.body.append(container, outside);
  root = createRoot(container);
  const scope = createRef<HTMLElement>();
  const inputRef = createRef<HTMLInputElement>();
  act(() =>
    root.render(
      <I18nProvider i18n={i18n}>
        <ChatFindBar scope={scope} inputRef={inputRef} onClose={onClose} />
      </I18nProvider>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  outside.remove();
  vi.unstubAllGlobals();
});

function pressEscape(target: Element, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

it("closes on Escape from inside the bar", () => {
  pressEscape(container.querySelector("input") as HTMLInputElement);
  expect(onClose).toHaveBeenCalledOnce();
});

it("closes on Escape while focus is elsewhere in the window", () => {
  outside.focus();
  pressEscape(outside);
  expect(onClose).toHaveBeenCalledOnce();
});

it("stays open for an Escape a menu or dialog already consumed", () => {
  outside.addEventListener("keydown", (event) => event.preventDefault());
  pressEscape(outside);
  expect(onClose).not.toHaveBeenCalled();
});

it("stays open for the Escape that ends an IME composition", () => {
  pressEscape(outside, { isComposing: true });
  pressEscape(outside, { keyCode: 229 });
  expect(onClose).not.toHaveBeenCalled();
});
