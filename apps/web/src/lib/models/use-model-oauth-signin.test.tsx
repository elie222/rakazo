// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useModelOAuthSignIn } from "./use-model-oauth-signin";

const models = vi.hoisted(() => ({ beginOAuth: vi.fn(), cancelOAuth: vi.fn() }));
const analytics = vi.hoisted(() => ({ modelSignInStep: vi.fn() }));
const desktop = vi.hoisted(() => ({ bridge: undefined as unknown }));
vi.mock("../query/space-rpc", () => ({ useSpaceRpc: () => ({ models, analytics }) }));
vi.mock("../platform/desktop", () => ({
  analyticsSurface: () => "web",
  desktopBridge: () => desktop.bridge,
  oauthStateOf: () => undefined,
  onDesktopOAuthCallback: vi.fn(),
}));
const waitForModelOAuth = vi.hoisted(() =>
  vi.fn(
    (_loginId: string, signal: AbortSignal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
  ),
);
vi.mock("./model-auth", () => ({ waitForModelOAuth }));

const verificationUri = "https://example.test/device";
let latest: ReturnType<typeof useModelOAuthSignIn>;
let root: Root;
let container: HTMLDivElement;
const onError = vi.fn();
function Harness() {
  latest = useModelOAuthSignIn({ onFinished: vi.fn(), onError });
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  models.beginOAuth.mockResolvedValue({
    mode: "device-code",
    loginId: "login",
    verificationUri,
    userCode: "ABCD-1234",
    expiresInSeconds: 300,
  });
  models.cancelOAuth.mockResolvedValue(undefined);
  analytics.modelSignInStep.mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});
afterEach(() => {
  desktop.bridge = undefined;
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("leaves a link sign-in's page to the person's click, since a tab opened later is blocked", async () => {
  models.beginOAuth.mockResolvedValue({
    mode: "auth-url",
    loginId: "login",
    verificationUri,
    expiresInSeconds: 300,
  });
  const open = vi.spyOn(window, "open");
  await act(async () => {
    void latest.startSubscriptionSignIn({ provider: "subscription" });
  });
  expect(open).not.toHaveBeenCalled();
  expect(latest.oauth).toMatchObject({ mode: "auth-url", verificationUri });
  expect(onError).not.toHaveBeenCalled();
  expect(models.beginOAuth.mock.calls[0]?.[0]).toMatchObject({ surface: "web", codePage: true });
  expect(analytics.modelSignInStep).not.toHaveBeenCalled();
});

it("asks for a code page on a desktop that cannot open the browser itself", async () => {
  desktop.bridge = { oauth: { onCallback: () => () => undefined } };
  await act(async () => {
    void latest.startSubscriptionSignIn({ provider: "subscription" });
  });
  expect(models.beginOAuth.mock.calls[0]?.[0]).toMatchObject({ codePage: true });
});

it("shows a device code before its page opens, leaving the opening to the person", async () => {
  const open = vi.spyOn(window, "open");
  await act(async () => {
    void latest.startSubscriptionSignIn({ provider: "subscription" });
  });
  expect(open).not.toHaveBeenCalled();
  expect(latest.oauth).toMatchObject({ userCode: "ABCD-1234", verificationUri });
  expect(onError).not.toHaveBeenCalled();
  expect(analytics.modelSignInStep).not.toHaveBeenCalled();

  // The person opens the link and copies the code themselves; each is told once.
  act(() => {
    latest.reportSignInStep("page_opened");
    latest.reportSignInStep("code_copied");
    latest.reportSignInStep("code_copied");
  });
  expect(analytics.modelSignInStep.mock.calls).toEqual([
    [{ loginId: "login", step: "page_opened" }],
    [{ loginId: "login", step: "code_copied" }],
  ]);
});

it("tells the server why a sign-in stopped: Cancel, a newer choice, or leaving", async () => {
  await act(async () => {
    void latest.startSubscriptionSignIn({ provider: "subscription" });
  });
  act(() => latest.cancelOAuthAttempt());
  expect(latest.oauth).toBeNull();

  await act(async () => {
    void latest.startSubscriptionSignIn({ provider: "subscription" });
  });
  act(() => latest.cancelOAuthAttempt("replaced"));

  await act(async () => {
    void latest.startSubscriptionSignIn({ provider: "subscription" });
  });
  act(() => root.unmount());
  root = createRoot(container);

  expect(models.cancelOAuth.mock.calls).toEqual([
    [{ loginId: "login", reason: "cancelled" }],
    [{ loginId: "login", reason: "replaced" }],
    [{ loginId: "login", reason: "left" }],
  ]);
});

it("tells the server a sign-in the app gave up on was interrupted, not cancelled", async () => {
  waitForModelOAuth.mockRejectedValueOnce(new Error("Sign-in timed out"));
  await act(async () => {
    await latest.startSubscriptionSignIn({ provider: "subscription" });
  });

  expect(onError).toHaveBeenCalledWith("Sign-in timed out");
  expect(models.cancelOAuth.mock.calls).toEqual([[{ loginId: "login", reason: "interrupted" }]]);
});
