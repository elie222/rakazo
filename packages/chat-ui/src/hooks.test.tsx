// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useNow, useTimeout } from "./hooks";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Timeout(props: { callback: () => void; ms: number | null; restartKey?: unknown }) {
  useTimeout(props.callback, props.ms, props.restartKey);
  return null;
}

it("runs the latest callback once, without restarting the wait when the callback changes", () => {
  const first = vi.fn();
  const latest = vi.fn();
  act(() => root.render(<Timeout callback={first} ms={100} />));
  act(() => vi.advanceTimersByTime(60));
  act(() => root.render(<Timeout callback={latest} ms={100} />));
  act(() => vi.advanceTimersByTime(40));
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledOnce();
  act(() => vi.advanceTimersByTime(1_000));
  expect(latest).toHaveBeenCalledOnce();
});

it("starts the wait again when the delay or the restart key changes", () => {
  const callback = vi.fn();
  act(() => root.render(<Timeout callback={callback} ms={100} restartKey="a" />));
  act(() => vi.advanceTimersByTime(60));
  act(() => root.render(<Timeout callback={callback} ms={100} restartKey="b" />));
  act(() => vi.advanceTimersByTime(60));
  act(() => root.render(<Timeout callback={callback} ms={80} restartKey="b" />));
  act(() => vi.advanceTimersByTime(60));
  expect(callback).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  act(() => vi.advanceTimersByTime(20));
  expect(callback).toHaveBeenCalledOnce();
});

it("waits for nothing while the delay is null", () => {
  const callback = vi.fn();
  act(() => root.render(<Timeout callback={callback} ms={100} />));
  act(() => root.render(<Timeout callback={callback} ms={null} />));
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(1_000));
  expect(callback).not.toHaveBeenCalled();
});

it("never fires after unmount", () => {
  const callback = vi.fn();
  act(() => root.render(<Timeout callback={callback} ms={100} />));
  act(() => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(1_000));
  expect(callback).not.toHaveBeenCalled();
  root = createRoot(container);
});

function Now({ ms, seen }: { ms: number | null; seen: number[] }) {
  seen.push(useNow(ms));
  return null;
}

it("ticks every interval, pauses on null and catches up at once when it resumes", () => {
  vi.setSystemTime(1_000);
  const seen: number[] = [];
  act(() => root.render(<Now ms={100} seen={seen} />));
  act(() => vi.advanceTimersByTime(250));
  expect(seen.at(-1)).toBe(1_200);
  act(() => root.render(<Now ms={null} seen={seen} />));
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(1_000));
  expect(seen.at(-1)).toBe(1_200);
  act(() => root.render(<Now ms={100} seen={seen} />));
  expect(seen.at(-1)).toBe(2_250);
});

it("stops ticking after unmount", () => {
  const seen: number[] = [];
  act(() => root.render(<Now ms={100} seen={seen} />));
  act(() => root.unmount());
  const renders = seen.length;
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(1_000));
  expect(seen).toHaveLength(renders);
  root = createRoot(container);
});
