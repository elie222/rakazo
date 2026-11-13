// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const account = vi.hoisted(() => ({ load: (_me: unknown) => {} }));

vi.mock("../lib/rpc", () => ({
  selectedSpaceId: () => null,
  rpc: {
    me: vi.fn(
      () =>
        new Promise((resolve) => {
          account.load = resolve;
        }),
    ),
    models: {
      list: vi.fn(async () => [
        {
          provider: "openai-compatible",
          providerName: "OpenAI-compatible",
          id: "",
          label: "Custom",
          billing: "API key",
          endpointPresets: [
            { name: "Ollama Cloud", baseUrl: "https://ollama.com/v1" },
            { name: "DeepInfra", baseUrl: "https://api.deepinfra.com/v1/openai" },
          ],
        },
      ]),
      probeOpenAiCompatible: vi.fn(async () => ({
        models: Array.from({ length: 11 }, (_, index) => `found-${index}`),
      })),
      connect: vi.fn(async () => ({})),
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

import { rpc } from "../lib/rpc";
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
    account.load({ needsModel: true, needsSignupSurvey: false, billingEnabled: false }),
  );
  expect(host.querySelector("h1")?.textContent).toBe("Connect a model");
  expect(marked()).not.toBeNull();
  act(() => root.unmount());
});

it("finds and searches a long custom endpoint list during onboarding", async () => {
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
    account.load({ needsModel: true, needsSignupSurvey: false, billingEnabled: false }),
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
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Find models")!
      .click(),
  );
  // Onboarding probes the endpoint the same way model settings does.
  expect(rpc.models.probeOpenAiCompatible).toHaveBeenCalledWith(
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

it("connects DeepInfra with a required key and the model's discovered capabilities", async () => {
  vi.mocked(rpc.models.list).mockResolvedValueOnce([
    {
      provider: "openai-compatible",
      providerName: "OpenAI-compatible",
      id: "",
      label: "Custom",
      billing: "API key",
      endpointPresets: [{ name: "DeepInfra", baseUrl: "https://api.deepinfra.com/v1/openai" }],
    },
  ] as never);
  vi.mocked(rpc.models.probeOpenAiCompatible).mockResolvedValueOnce({
    models: ["vision-model", "text-model"],
    details: [
      {
        id: "vision-model",
        supportsImages: true,
        reasoning: true,
        contextWindow: 131072,
        cacheCapabilities: { scope: "connection" as const },
      },
      { id: "text-model", supportsImages: false, reasoning: false, contextWindow: 32768 },
    ],
  });
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
    account.load({ needsModel: true, needsSignupSurvey: false, billingEnabled: false }),
  );
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Provider"]')!.click());
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === "DeepInfra")!
      .click(),
  );
  const input = (selector: string) => document.querySelector<HTMLInputElement>(selector)!;
  const change = async (element: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        element,
        value,
      );
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const button = (text: string) =>
    [...document.querySelectorAll("button")].find((entry) => entry.textContent === text)!;
  expect(input('input[aria-label="OpenAI-compatible server URL"]').value).toBe(
    "https://api.deepinfra.com/v1/openai",
  );
  expect(document.body.textContent).not.toContain("Setup help");
  const key = input('input[aria-label="API key"]');
  expect(key.required).toBe(true);
  await change(key, "fake-fixture-key");
  await act(async () => button("Find models").click());
  await act(async () =>
    document.querySelector<HTMLElement>('[aria-label="Models from server"]')!.click(),
  );
  expect([...document.querySelectorAll("[cmdk-item]")].map((row) => row.textContent)).toEqual([
    "vision-modelImages · Thinking",
    "text-model",
    "Other model…",
  ]);
  await act(async () => document.querySelectorAll<HTMLElement>("[cmdk-item]")[1]!.click());
  await act(async () => button("Continue").click());
  expect(rpc.models.connect).toHaveBeenLastCalledWith(
    expect.objectContaining({
      provider: "openai-compatible",
      baseUrl: "https://api.deepinfra.com/v1/openai",
      apiKey: "fake-fixture-key",
      modelId: "text-model",
      reasoning: false,
      supportsImages: false,
      contextWindow: 32768,
      // The listing describes this model as having no prompt cache, which is sent as such.
      cacheCapabilitiesByModel: { "text-model": null },
    }),
  );
  expect(vi.mocked(rpc.models.connect).mock.lastCall?.[0]).not.toHaveProperty("cacheCapabilities");
  await act(async () => root.unmount());
});

it("does not carry one found model's reasoning effort over to another", async () => {
  vi.mocked(rpc.models.list).mockResolvedValueOnce([
    {
      provider: "openai-compatible",
      providerName: "OpenAI-compatible",
      id: "",
      label: "Custom",
      billing: "API key",
      endpointPresets: [{ name: "DeepInfra", baseUrl: "https://api.deepinfra.com/v1/openai" }],
    },
  ] as never);
  vi.mocked(rpc.models.probeOpenAiCompatible).mockResolvedValueOnce({
    models: ["think-a", "think-b"],
    details: [
      { id: "think-a", supportsImages: false, reasoning: true },
      { id: "think-b", supportsImages: false, reasoning: true },
    ],
  });
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
    account.load({ needsModel: true, needsSignupSurvey: false, billingEnabled: false }),
  );
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Provider"]')!.click());
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === "DeepInfra")!
      .click(),
  );
  const key = document.querySelector<HTMLInputElement>('input[aria-label="API key"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      key,
      "fake-fixture-key",
    );
    key.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = (text: string) =>
    [...document.querySelectorAll("button")].find((entry) => entry.textContent === text)!;
  const pickFound = async (index: number) => {
    await act(async () =>
      document.querySelector<HTMLElement>('[aria-label="Models from server"]')!.click(),
    );
    await act(async () => document.querySelectorAll<HTMLElement>("[cmdk-item]")[index]!.click());
  };
  await act(async () => button("Find models").click());
  await pickFound(0);
  await act(async () =>
    document.querySelector<HTMLElement>('[aria-label="Reasoning effort"]')!.click(),
  );
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === "High")!
      .click(),
  );
  expect(document.querySelector('[aria-label="Reasoning effort"]')?.textContent).toBe("High");
  await pickFound(1);
  await act(async () => button("Continue").click());
  const sent = vi.mocked(rpc.models.connect).mock.lastCall?.[0] as {
    modelId?: string;
    thinkingLevel?: unknown;
  };
  expect(sent.modelId).toBe("think-b");
  expect(sent.thinkingLevel ?? null).toBeNull();
  await act(async () => root.unmount());
});

it("keeps Continue disabled for a hosted preset until its key is entered", async () => {
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
    account.load({ needsModel: true, needsSignupSurvey: false, billingEnabled: false }),
  );
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Provider"]')!.click());
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === "Ollama Cloud")!
      .click(),
  );
  const continueButton = [...document.querySelectorAll("button")].find(
    (entry) => entry.textContent === "Continue",
  )!;
  expect(document.querySelector<HTMLInputElement>('input[aria-label="API key"]')?.required).toBe(
    true,
  );
  expect(continueButton.disabled).toBe(true);
  await act(async () => root.unmount());
});
