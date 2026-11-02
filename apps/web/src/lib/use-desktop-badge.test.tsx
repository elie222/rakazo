// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RakazoDesktop } from "./desktop";
import { useDesktopBadge } from "./use-desktop-badge";

let root: Root;
const set = vi.fn(async () => true);
function Harness({ count, signedIn = true }: { count: number | undefined; signedIn?: boolean }) {
  useDesktopBadge(signedIn ? count : 0);
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  set.mockReset().mockResolvedValue(true);
  window.rakazoDesktop = { badge: { set } } as unknown as RakazoDesktop;
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  delete window.rakazoDesktop;
  vi.unstubAllGlobals();
});

it("deduplicates counts and clears when the last chat is read", async () => {
  for (const count of [2, 2, 1, 0, 0])
    await act(async () => root.render(<Harness count={count} />));
  expect(set.mock.calls).toEqual([[2], [1], [0]]);
  await act(async () => root.render(null));
  expect(set.mock.calls).toEqual([[2], [1], [0]]);
});

it("clears on sign-out even if roster data remains", async () => {
  await act(async () => root.render(<Harness count={3} />));
  await act(async () => root.render(<Harness count={3} signedIn={false} />));
  expect(set.mock.calls).toEqual([[3], [0]]);
});

it("clears on unmount and tolerates rejected IPC calls", async () => {
  set.mockRejectedValue(new Error("Window closed"));
  await act(async () => root.render(<Harness count={4} />));
  await act(async () => root.render(null));
  expect(set.mock.calls).toEqual([[4], [0]]);
});

it.each([undefined, {} as RakazoDesktop])(
  "does nothing without the optional badge bridge (%s)",
  async (bridge) => {
    window.rakazoDesktop = bridge;
    await act(async () => root.render(<Harness count={2} />));
    await act(async () => root.render(<Harness count={0} />));
    await act(async () => root.render(null));
    expect(set).not.toHaveBeenCalled();
  },
);

it("clears an unavailable account total outside the shell", async () => {
  await act(async () => root.render(<Harness count={6} />));
  await act(async () => root.render(<Harness count={undefined} />));
  await act(async () => root.render(null));
  expect(set.mock.calls).toEqual([[6], [0]]);
});

function Roster({ count }: { count: number | undefined }) {
  useDesktopBadge(count, "roster");
  return null;
}
function Accounts({
  total,
  fallback,
  shell = true,
}: {
  total: number | undefined;
  fallback?: number;
  shell?: boolean;
}) {
  useDesktopBadge(total);
  return shell ? <Roster count={fallback} /> : null;
}

it("hands the badge between account totals and the mounted roster without clearing either", async () => {
  await act(async () => root.render(<Accounts total={8} />));
  await act(async () => root.render(<Accounts total={undefined} fallback={4} />));
  await act(async () => root.render(<Accounts total={undefined} fallback={4} />));
  await act(async () => root.render(<Accounts total={7} />));
  await act(async () => root.render(<Accounts total={7} shell={false} />));
  expect(set.mock.calls).toEqual([[8], [4], [7]]);
  await act(async () => root.render(<Accounts total={undefined} shell={false} />));
  expect(set.mock.calls).toEqual([[8], [4], [7], [0]]);
});

it("clears a departing roster only when no account total owns the badge", async () => {
  await act(async () => root.render(<Accounts total={undefined} fallback={4} />));
  await act(async () => root.render(<Accounts total={undefined} shell={false} />));
  expect(set.mock.calls).toEqual([[4], [0]]);
});

it("keeps a known zero account total ahead of a stale roster count", async () => {
  await act(async () => root.render(<Accounts total={0} fallback={4} />));
  expect(set.mock.calls).toEqual([[0]]);
  await act(async () => root.render(<Accounts total={undefined} fallback={4} />));
  expect(set.mock.calls).toEqual([[0], [4]]);
});

it("clears the previous bridge and publishes to its replacement", async () => {
  await act(async () => root.render(<Accounts total={8} fallback={4} />));
  const replacement = vi.fn(async () => true);
  window.rakazoDesktop = { badge: { set: replacement } } as unknown as RakazoDesktop;
  await act(async () => root.render(<Accounts total={undefined} fallback={4} />));
  expect(set.mock.calls).toEqual([[8], [0]]);
  expect(replacement.mock.calls).toEqual([[4]]);
  await act(async () => root.render(null));
  expect(replacement.mock.calls).toEqual([[4], [0]]);
});
