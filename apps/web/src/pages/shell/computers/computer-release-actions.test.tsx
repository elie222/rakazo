// @vitest-environment jsdom

import type { ComputerReleaseReason } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));

import { ComputerReleaseActions } from "./computer-release-actions";

let container: HTMLDivElement;
let root: Root;

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((item) => item.textContent === label);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("disables Hand back control while the release is in flight", async () => {
  const pending = deferred();
  const onRelease = vi.fn<(_reason?: ComputerReleaseReason) => Promise<void>>(
    () => pending.promise,
  );

  await act(async () => {
    root.render(<ComputerReleaseActions takeoverRequested={false} onRelease={onRelease} />);
  });

  const handBack = button("Hand back control");
  expect(handBack?.disabled).toBe(false);

  await act(async () => {
    handBack?.click();
    handBack?.click();
  });

  expect(onRelease).toHaveBeenCalledTimes(1);
  expect(onRelease).toHaveBeenCalledWith(undefined);
  expect(button("Hand back control")?.disabled).toBe(true);

  await act(async () => {
    pending.resolve();
    await pending.promise;
  });

  expect(button("Hand back control")?.disabled).toBe(false);
});

it("disables both Skip and I’m done once either button is pressed until the release settles", async () => {
  const pending = deferred();
  const onRelease = vi.fn<(_reason?: ComputerReleaseReason) => Promise<void>>(
    () => pending.promise,
  );

  await act(async () => {
    root.render(<ComputerReleaseActions takeoverRequested={true} onRelease={onRelease} />);
  });

  const skip = button("Skip");
  const done = button("I’m done");
  expect(skip?.disabled).toBe(false);
  expect(done?.disabled).toBe(false);

  await act(async () => {
    done?.click();
    skip?.click();
  });

  expect(onRelease).toHaveBeenCalledTimes(1);
  expect(onRelease).toHaveBeenCalledWith("done");
  expect(button("Skip")?.disabled).toBe(true);
  expect(button("I’m done")?.disabled).toBe(true);

  await act(async () => {
    pending.resolve();
    await pending.promise;
  });

  expect(button("Skip")?.disabled).toBe(false);
  expect(button("I’m done")?.disabled).toBe(false);
});
