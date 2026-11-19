// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { NavigateFunction } from "react-router-dom";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let account = deferred<unknown>();

vi.mock("../../lib/query/rpc", () => ({
  selectedSpaceId: () => null,
  rpc: {
    onboarding: { firstBot: vi.fn() },
    me: vi.fn(() => {
      account = deferred();
      return account.promise;
    }),
    models: {
      list: vi.fn(async () => [
        {
          provider: "openai-compatible",
          providerName: "OpenAI-compatible",
          id: "",
          label: "Custom",
          billing: "API key",
        },
      ]),
      probeOpenAiCompatible: vi.fn(async () => ({
        models: Array.from({ length: 11 }, (_, index) => `found-${index}`),
      })),
    },
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

import { rpc } from "../../lib/query/rpc";
import { OnboardingPage } from "./Onboarding";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
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
    account.resolve({ needsModel: true, needsSignupSurvey: false, billingEnabled: false }),
  );
  expect(host.querySelector("h1")?.textContent).toBe("Connect a model");
  expect(marked()).not.toBeNull();
  act(() => root.unmount());
});

it("recovers a failed discovery and searches a long custom endpoint list during onboarding", async () => {
  const probe = vi.mocked(rpc.models.probeOpenAiCompatible);
  probe.mockClear();
  probe.mockRejectedValueOnce(new Error("Temporary discovery failure"));
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await act(async () =>
    account.resolve({ needsModel: true, needsSignupSurvey: false, billingEnabled: false }),
  );
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Provider"]')!.click());
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === "OpenAI-compatible")!
      .click(),
  );
  const change = async (label: string, value: string) => {
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await change("OpenAI-compatible server URL", "https://models.example.test/v1");
  await act(async () =>
    vi.waitFor(() => expect(rpc.models.probeOpenAiCompatible).toHaveBeenCalled()),
  );
  expect(document.body.textContent).toContain("Temporary discovery failure");
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Try again")!
      .click(),
  );
  expect(probe).toHaveBeenCalledTimes(2);
  expect(probe).toHaveBeenLastCalledWith(
    expect.objectContaining({
      baseUrl: "https://models.example.test/v1",
      apiProtocol: "chat-completions",
    }),
  );
  await act(async () =>
    document.querySelector<HTMLElement>('[aria-label="Models from server"]')!.click(),
  );
  await change("Search models", "found-10");
  expect([...document.querySelectorAll("[cmdk-item]")].map((row) => row.textContent)).toEqual([
    "found-10",
    "Other model…",
  ]);
  await act(async () => document.querySelector<HTMLElement>("[cmdk-item]")!.click());
  expect(document.querySelector('[aria-label="Models from server"]')?.textContent).toBe("found-10");
  await act(async () => root.unmount());
});

it.each([
  [
    "arrives",
    () => account.resolve({ needsModel: true, needsSignupSurvey: false, billingEnabled: false }),
  ],
  ["fails", () => account.reject(new Error("offline"))],
])("stays on the next page when the account read %s after leaving", async (_outcome, settle) => {
  const router = {} as { navigate: NavigateFunction; pathname: string };
  function Router() {
    router.navigate = useNavigate();
    router.pathname = useLocation().pathname;
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Router />
        <Routes>
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
          <Route path="/sign-in" element={null} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await act(async () => router.navigate("/sign-in"));
  expect(router.pathname).toBe("/sign-in");

  await act(async () => settle());
  expect(router.pathname).toBe("/sign-in");
  act(() => root.unmount());
});

it.each([
  ["opens the first bot the server made", "chief-1", "/app/chief-1"],
  ["opens the Space as it is when the server made none", null, "/app"],
])("%s", async (_name, botId, path) => {
  vi.mocked(rpc.onboarding.firstBot).mockResolvedValue({ botId });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  let pathname = "";
  function Location() {
    pathname = useLocation().pathname;
    return null;
  }
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
          <Route path="/app/*" element={null} />
        </Routes>
        <Location />
      </MemoryRouter>,
    ),
  );
  await act(async () =>
    account.resolve({ needsModel: false, needsSignupSurvey: false, billingEnabled: false }),
  );
  await vi.waitFor(() => expect(pathname).toBe(path));
  expect(rpc.onboarding.firstBot).toHaveBeenCalledOnce();
  act(() => root.unmount());
});
