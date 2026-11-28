// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { ModelCatalogEntry } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { NavigateFunction } from "react-router-dom";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let account = deferred<unknown>();

vi.mock("../../lib/query/rpc", () => ({
  selectedSpaceId: () => null,
  rpc: {
    onboarding: { firstBot: vi.fn() },
    billing: { selectFunding: vi.fn(async () => ({ ok: true })) },
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

const hostedCatalog: ModelCatalogEntry[] = [
  {
    provider: "openai-codex",
    providerName: "OpenAI Codex",
    subscriptionName: "ChatGPT subscription",
    id: "codex-model",
    label: "Codex model",
    billing: "Subscription",
    auth: "oauth",
    signIn: "device-code",
  },
  {
    provider: "anthropic",
    providerName: "Anthropic",
    subscriptionName: "Claude subscription",
    id: "claude-model",
    label: "Claude model",
    billing: "API key or subscription",
    auth: "both",
    signIn: "auth-url",
  },
  {
    provider: "openai",
    providerName: "OpenAI",
    id: "gpt-model",
    label: "GPT model",
    billing: "API key",
  },
  {
    provider: "mistral",
    providerName: "Mistral",
    id: "mistral-model",
    label: "Mistral model",
    billing: "API key",
  },
  {
    provider: "github-copilot",
    providerName: "GitHub Copilot",
    id: "copilot-model",
    label: "Copilot model",
    billing: "Subscription",
    auth: "oauth",
    signIn: "device-code",
  },
  {
    provider: "xai",
    providerName: "xAI",
    id: "grok-model",
    label: "Grok model",
    billing: "API key or subscription",
    auth: "both",
    signIn: "device-code",
  },
];

const roots = new Set<Root>();

function mountRoot(host = document.body.appendChild(document.createElement("div"))) {
  const root = createRoot(host);
  roots.add(root);
  return root;
}

async function cleanup() {
  await act(async () => {
    for (const root of roots) root.unmount();
    roots.clear();
    // Session stores defer their cleanup after the last subscriber leaves. Run it
    // while jsdom still owns window, before restoring real timers and globals.
    await vi.runOnlyPendingTimersAsync();
  });
}

beforeEach(() => {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(null)),
  );
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
afterEach(async () => {
  try {
    await cleanup();
  } finally {
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

it("marks onboarding as usable for the desktop only once a step shows", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = mountRoot(host);
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
});

it("recovers a failed discovery and searches a long custom endpoint list during onboarding", async () => {
  const probe = vi.mocked(rpc.models.probeOpenAiCompatible);
  probe.mockClear();
  probe.mockRejectedValueOnce(new Error("Temporary discovery failure"));
  const root = mountRoot();
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
  const root = mountRoot();
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
});

it.each([
  ["opens the first bot the server made", "chief-1", "/app/chief-1"],
  ["opens the Space as it is when the server made none", null, "/app"],
])("%s", async (_name, botId, path) => {
  vi.mocked(rpc.onboarding.firstBot).mockResolvedValue({ botId });
  const host = document.body.appendChild(document.createElement("div"));
  const root = mountRoot(host);
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
});

it("cleans up the account session before the browser globals are torn down", async () => {
  const removeListener = vi.spyOn(window, "removeEventListener");
  const root = mountRoot();
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
  expect(document.querySelector('[aria-label="Account"]')).not.toBeNull();

  await cleanup();

  // Model environment teardown without relying on a race with the real clock.
  const browserWindow = window;
  vi.stubGlobal("window", undefined);
  Reflect.deleteProperty(globalThis, "window");
  try {
    await vi.runOnlyPendingTimersAsync();
  } finally {
    vi.stubGlobal("window", browserWindow);
  }
  expect(removeListener).toHaveBeenCalledWith("storage", expect.any(Function));
});

it("starts a hosted account by choosing credits, a subscription, or an API key", async () => {
  vi.mocked(rpc.models.list).mockResolvedValueOnce(hostedCatalog);
  const root = mountRoot();
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
    account.resolve({ needsModel: true, needsSignupSurvey: false, billingEnabled: true }),
  );
  const choice = (name: string) =>
    [...document.querySelectorAll('[data-slot="field-label"]')]
      .find((label) => label.textContent === name)
      ?.querySelector<HTMLElement>('[role="radio"]') ?? null;
  const checked = () =>
    [...document.querySelectorAll('[role="radio"][aria-checked="true"]')].map(
      (radio) => radio.closest('[data-slot="field-label"]')?.textContent,
    );
  const button = (name: string) =>
    [...document.querySelectorAll("button")].find((entry) => entry.textContent === name);
  const providerPicker = () => document.querySelector<HTMLElement>('[aria-label="Provider"]');

  expect(checked()).toEqual([]);
  expect(providerPicker()).toBeNull();
  expect(button("Continue")).toBeUndefined();

  await act(async () => choice("Use a subscription")!.click());
  expect(button("Continue")).toBeUndefined();
  expect(
    [
      ...document.querySelectorAll(
        '[role="radiogroup"][aria-label="Use a subscription"] [role="radio"]',
      ),
    ].map((radio) => radio.closest('[data-slot="field-label"]')?.textContent),
  ).toEqual(["ChatGPT subscription", "Claude subscription", "GitHub Copilot", "xAI"]);
  await act(async () => choice("Claude subscription")!.click());
  expect(checked()).toEqual(["Use a subscription", "Claude subscription"]);
  expect(button("Sign in")).toBeDefined();
  expect(document.querySelector('input[type="password"]')).toBeNull();

  await act(async () => choice("Use an API key")!.click());
  expect(choice("Claude subscription")).toBeNull();
  expect(button("Sign in")).toBeUndefined();
  await act(async () => providerPicker()!.click());
  expect(
    [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent),
  ).toEqual(["OpenAI API", "Anthropic API", "Mistral", "xAI"]);
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === "OpenAI API")!
      .click(),
  );
  expect(document.querySelector('input[type="password"]')).not.toBeNull();

  await act(async () => choice("Rakazo credits")!.click());
  expect(providerPicker()).toBeNull();
  expect(document.querySelector('input[type="password"]')).toBeNull();
  await act(async () => button("Continue")!.click());
  expect(rpc.billing.selectFunding).toHaveBeenCalledWith({ funding: "credits", surface: "web" });
});

it("keeps the provider list for self-hosted accounts", async () => {
  vi.mocked(rpc.models.list).mockResolvedValueOnce(hostedCatalog);
  const root = mountRoot();
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
  expect(document.querySelector('[role="radio"]')).toBeNull();
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Provider"]')!.click());
  expect(
    [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent),
  ).toEqual([
    "ChatGPT subscription",
    "Claude subscription",
    "OpenAI API",
    "Anthropic API",
    "GitHub Copilot",
    "Mistral",
    "xAI",
  ]);
});
