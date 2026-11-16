// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEventListener } from "./use-event-listener";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Listener(props: {
  target: EventTarget | null;
  type?: string;
  handler: (event: Event) => void;
  options?: boolean | AddEventListenerOptions;
}) {
  useEventListener(props.target, props.type ?? "ping", props.handler, props.options);
  return null;
}

it("calls the latest handler without subscribing again", () => {
  const target = new EventTarget();
  const add = vi.spyOn(target, "addEventListener");
  const remove = vi.spyOn(target, "removeEventListener");
  const first = vi.fn();
  const latest = vi.fn();
  act(() => root.render(<Listener target={target} handler={first} />));
  act(() => root.render(<Listener target={target} handler={latest} />));
  target.dispatchEvent(new Event("ping"));
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledOnce();
  expect(add).toHaveBeenCalledOnce();
  expect(remove).not.toHaveBeenCalled();
});

it("moves to a new target or type, and a null target listens to nothing", () => {
  const before = new EventTarget();
  const after = new EventTarget();
  const handler = vi.fn();
  act(() => root.render(<Listener target={before} handler={handler} />));
  act(() => root.render(<Listener target={after} handler={handler} />));
  before.dispatchEvent(new Event("ping"));
  after.dispatchEvent(new Event("ping"));
  expect(handler).toHaveBeenCalledOnce();
  act(() => root.render(<Listener target={after} type="pong" handler={handler} />));
  after.dispatchEvent(new Event("ping"));
  after.dispatchEvent(new Event("pong"));
  expect(handler).toHaveBeenCalledTimes(2);
  act(() => root.render(<Listener target={null} type="pong" handler={handler} />));
  after.dispatchEvent(new Event("pong"));
  expect(handler).toHaveBeenCalledTimes(2);
});

it("passes capture, passive and once through, and removes the capture listener it added", () => {
  const target = new EventTarget();
  const add = vi.spyOn(target, "addEventListener");
  const remove = vi.spyOn(target, "removeEventListener");
  const handler = vi.fn();
  const options = { capture: true, passive: true, once: true };
  act(() => root.render(<Listener target={target} handler={handler} options={options} />));
  expect(add.mock.calls[0]?.[2]).toEqual(options);
  target.dispatchEvent(new Event("ping"));
  target.dispatchEvent(new Event("ping"));
  expect(handler).toHaveBeenCalledOnce();
  act(() => root.unmount());
  expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
  expect(remove.mock.calls[0]?.[2]).toBe(true);
  root = createRoot(container);
});

it("hears nothing after unmount", () => {
  const target = new EventTarget();
  const handler = vi.fn();
  act(() => root.render(<Listener target={target} handler={handler} />));
  act(() => root.unmount());
  target.dispatchEvent(new Event("ping"));
  expect(handler).not.toHaveBeenCalled();
  root = createRoot(container);
});
