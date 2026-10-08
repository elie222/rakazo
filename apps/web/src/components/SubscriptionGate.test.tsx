// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ me: vi.fn(), status: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { me: api.me, billing: { status: api.status } } }));
vi.mock("../lib/bootstrap", () => ({ peekInitialBootstrap: () => undefined }));
vi.mock("../pages/Paywall", () => ({ PaywallPage: () => <div>paywall</div> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Fresh module per test: the capability lookup is cached for the page's lifetime. */
async function renderGate(billing: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        billing,
        passwordAuth: true,
        sso: null,
        passwordReset: false,
        resetUrl: null,
      }),
    ),
  );
  vi.resetModules();
  const { SubscriptionGate } = await import("./SubscriptionGate");
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SubscriptionGate fallback={<div>loading</div>}>
        <div>app</div>
      </SubscriptionGate>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { container, root };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("opens without waiting on me or billing when the deployment does not bill", async () => {
  const { container, root } = await renderGate(false);
  expect(container.textContent).toBe("app");
  expect(api.me).not.toHaveBeenCalled();
  expect(api.status).not.toHaveBeenCalled();
  act(() => root.unmount());
});

it("skips the billing request for users billing does not apply to", async () => {
  api.me.mockResolvedValue({ billingEnabled: false });
  const { container, root } = await renderGate(true);
  expect(container.textContent).toBe("app");
  expect(api.status).not.toHaveBeenCalled();
  act(() => root.unmount());
});

it("shows the paywall without access and opens once a recheck finds access", async () => {
  api.me.mockResolvedValue({ billingEnabled: true });
  api.status.mockResolvedValue({ access: false });
  const { container, root } = await renderGate(true);
  expect(container.textContent).toBe("paywall");

  api.status.mockResolvedValue({ access: true });
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.textContent).toBe("app");
  act(() => root.unmount());
});
