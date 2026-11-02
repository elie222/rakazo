// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

const account = vi.hoisted(() => ({ load: (_me: unknown) => {} }));

vi.mock("../lib/rpc", () => ({
  rpc: {
    me: vi.fn(
      () =>
        new Promise((resolve) => {
          account.load = resolve;
        }),
    ),
    models: { list: vi.fn(async () => []) },
  },
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values);
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
    Plural: ({ one, other, value }: { one: string; other: string; value: number }) =>
      value === 1 ? one : other,
  };
});

import { OnboardingPage } from "./Onboarding";

afterEach(() => {
  document.body.innerHTML = "";
});

it("marks onboarding as usable for the desktop only once a step shows", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  // The shell sends a new account to /onboarding, which loads before it picks a step.
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  const marked = () => host.querySelector('[data-rakazo-surface="onboarding"]');
  expect(marked()).toBeNull();

  await act(async () =>
    account.load({ needsModel: true, needsSignupSurvey: false, billingEnabled: false }),
  );
  expect(host.querySelector("h1")?.textContent).toBe("Connect a model");
  expect(marked()).not.toBeNull();
  act(() => root.unmount());
});
