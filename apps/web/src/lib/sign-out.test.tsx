// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signOut, useSignOut } from "./sign-out";

const { requestSignOut, getSession, refetch } = vi.hoisted(() => ({
  requestSignOut: vi.fn(),
  getSession: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("./auth", () => ({
  authClient: {
    signOut: requestSignOut,
    getSession,
    $store: { atoms: { session: { get: () => ({ refetch }) } } },
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  requestSignOut.mockResolvedValue({ data: { success: true }, error: null });
  getSession.mockResolvedValue({ data: null, error: null });
  refetch.mockResolvedValue(undefined);
});

describe("signOut", () => {
  it("handles an error result without checking the session", async () => {
    requestSignOut.mockResolvedValue({ data: null, error: { status: 500 } });
    expect(await signOut()).toBe(false);
    expect(getSession).not.toHaveBeenCalled();
    expect(refetch).not.toHaveBeenCalled();
  });

  it("handles a rejected sign-out request", async () => {
    requestSignOut.mockRejectedValue(new Error("Network unavailable"));
    expect(await signOut()).toBe(false);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("fails if the server still has the session", async () => {
    getSession.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    expect(await signOut()).toBe(false);
    expect(getSession).toHaveBeenCalledWith({ query: { disableCookieCache: true } });
    expect(refetch).not.toHaveBeenCalled();
  });

  it("fails if the session check returns an error", async () => {
    getSession.mockResolvedValue({ data: null, error: { status: 500 } });
    expect(await signOut()).toBe(false);
  });

  it("handles a rejected session check", async () => {
    getSession.mockRejectedValue(new Error("Network unavailable"));
    expect(await signOut()).toBe(false);
  });

  it("still succeeds when the shared refresh is superseded or fails", async () => {
    refetch.mockRejectedValue(new Error("aborted"));
    expect(await signOut()).toBe(true);
  });

  it("refreshes the shared session before succeeding", async () => {
    let finishRefresh = () => {};
    refetch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const result = signOut();
    await vi.waitFor(() => expect(refetch).toHaveBeenCalledOnce());
    expect(refetch).toHaveBeenCalledWith({ query: { disableCookieCache: true } });
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishRefresh();
    expect(await result).toBe(true);
    expect(requestSignOut).toHaveBeenCalledOnce();
  });
});

it("blocks re-entry, reports failure, and allows a successful retry", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onSuccess = vi.fn();
  const onError = vi.fn();
  let controls: ReturnType<typeof useSignOut>;
  function Harness() {
    controls = useSignOut(onSuccess, onError);
    return (
      <button type="button" disabled={controls.signingOut} onClick={() => void controls.logOut()} />
    );
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  let finishRequest = () => {};
  requestSignOut.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRequest = () => resolve({ error: { status: 500 } });
      }),
  );
  try {
    act(() => root.render(<Harness />));
    let pending: Promise<void>;
    act(() => {
      pending = controls.logOut();
      void controls.logOut();
    });
    expect(container.querySelector("button")?.disabled).toBe(true);
    expect(requestSignOut).toHaveBeenCalledOnce();
    await act(async () => {
      finishRequest();
      await pending;
    });
    expect(onError).toHaveBeenCalledWith("Could not log out. Try again.");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(container.querySelector("button")?.disabled).toBe(false);
    await act(async () => {
      await controls.logOut();
    });
    expect(onSuccess).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});
