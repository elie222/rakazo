import { expect, it } from "vitest";
import { createMessagingLinkGuard } from "./messaging-link-guard.js";

it("guards repeated starts synchronously and permits another after completion", () => {
  const guard = createMessagingLinkGuard();
  const first = guard.begin()!;
  expect(guard.begin()).toBeNull();
  first.finish();
  const second = guard.begin()!;
  expect(second.isCurrent()).toBe(true);
  expect(first.isCurrent()).toBe(false);
  first.finish();
  expect(guard.begin()).toBeNull();
  second.finish();
  expect(guard.begin()).not.toBeNull();
});

it("invalidates picker requests without allowing overlapping issuance", () => {
  const guard = createMessagingLinkGuard();
  const request = guard.begin()!;
  expect(guard.invalidate(true)).toBe(true);
  expect(request.isCurrent()).toBe(false);
  expect(guard.begin()).toBeNull();
  request.finish();
  expect(guard.begin()!.isCurrent()).toBe(true);
});

it("preserves workspace requests and displayed codes across picker changes", () => {
  const guard = createMessagingLinkGuard();
  const workspace = guard.begin(false)!;
  expect(guard.invalidate(true)).toBe(false);
  expect(workspace.isCurrent()).toBe(true);
  workspace.finish();
  expect(guard.invalidate(true)).toBe(false);
  expect(workspace.isCurrent()).toBe(true);
  const picker = guard.begin()!;
  expect(workspace.isCurrent()).toBe(false);
  expect(guard.invalidate(true)).toBe(true);
  expect(picker.isCurrent()).toBe(false);
});

it.each([true, false])(
  "invalidates all request kinds on exit or another action (%s)",
  (pickerBound) => {
    const guard = createMessagingLinkGuard();
    const request = guard.begin(pickerBound)!;
    expect(guard.invalidate()).toBe(true);
    expect(request.isCurrent()).toBe(false);
    expect(guard.begin()).toBeNull();
    request.finish();
    expect(guard.begin()).not.toBeNull();
  },
);
