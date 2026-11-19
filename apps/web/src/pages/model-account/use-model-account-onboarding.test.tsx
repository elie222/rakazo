// @vitest-environment jsdom

import type { ModelAccountConfig } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
  data: undefined as ModelAccountConfig | undefined,
  error: null as Error | null,
  isFetching: false,
  refetch: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => config }));
vi.mock("@lingui/react/macro", () => ({ Trans: ({ children }: { children: string }) => children }));
vi.mock("../../components/PageLoading", () => ({ PageLoading: () => <p>Loading</p> }));
vi.mock("../../components/ModelAccountOnboarding", () => ({
  ModelAccountOnboarding: ({ onReady }: { onReady: () => void }) => (
    <button type="button" onClick={onReady}>
      Account setup
    </button>
  ),
}));
vi.mock("../../lib/query/user-error", () => ({ errorText: (error: Error) => error.message }));

import { useModelAccountOnboarding } from "./use-model-account-onboarding";

it("isolates loading and retry from other steps and selects the existing form for ordinary mode", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const ready = vi.fn();
  function Page({ step }: { step: string }) {
    const account = useModelAccountOnboarding(step, ready);
    if (step !== "model") return <p>Original step</p>;
    return account.accountMode ? account.content : <p>Original model form</p>;
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const render = (step: string) => act(() => root.render(<Page step={step} />));
  try {
    render("survey");
    expect(host.textContent).toBe("Original step");
    render("model");
    expect(host.textContent).toBe("Loading");
    config.error = new Error("offline");
    render("model");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("offline");
    expect(host.textContent).not.toContain("Original model form");
    await act(async () => host.querySelector("button")!.click());
    expect(config.refetch).toHaveBeenCalledOnce();
    config.error = null;
    config.data = { enabled: false, modelAccountOnly: false };
    render("model");
    expect(host.textContent).toBe("Original model form");
    config.data = { enabled: true, modelAccountOnly: true };
    render("model");
    expect(host.textContent).toBe("Account setup");
    await act(async () => host.querySelector("button")!.click());
    expect(ready).toHaveBeenCalledOnce();
    render("bot");
    expect(host.textContent).toBe("Original step");
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
