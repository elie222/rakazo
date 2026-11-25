// @vitest-environment jsdom
import type { DeploymentModelSettings as Settings } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import type * as UiWeb from "@rakazo/ui-web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeploymentModelSettings } from "./deployment-model-settings";

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", async (importOriginal) => ({
  Button: ({ size: _size, ...props }: ComponentProps<"button"> & { size?: string }) => (
    <button {...props} />
  ),
  Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FieldGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  OptionSelect: (await importOriginal<typeof UiWeb>()).OptionSelect,
  SectionHeading: ({ children }: { children?: ReactNode }) => <h3>{children}</h3>,
}));
vi.mock("../../components/ai/primitives", () => ({ SuccessPop: () => null }));
const { deployment } = vi.hoisted(() => ({ deployment: { get: vi.fn(), update: vi.fn() } }));
// Like the real client, every property read returns a new object.
vi.mock("../../lib/query/rpc", () => {
  const rpc = {
    me: vi.fn(),
    get models() {
      return {
        get deployment() {
          return { ...deployment };
        },
      };
    },
  };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});

const providers: Settings["providers"] = [
  {
    id: "example-provider",
    name: "Example Provider",
    models: [
      { id: "small-model", label: "Small" },
      { id: "large-model", label: "Large" },
    ],
  },
  { id: "other-provider", name: "Other Provider", models: [{ id: "other-model", label: "Other" }] },
];
const saved: Settings = {
  provider: "example-provider",
  modelId: "small-model",
  keySaved: true,
  providers,
};
const noProvidersOrKey: Settings = {
  provider: null,
  modelId: null,
  keySaved: false,
  providers: [],
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <DeploymentModelSettings />
      </QueryClientProvider>,
    ),
  );
  // The read answers after the first render.
  await act(() => vi.waitFor(() => expect(deployment.get).toHaveBeenCalled()));
  await act(() => vi.waitFor(() => expect(host.querySelector("h3")).not.toBeNull()));
}

function field(label: string) {
  const id = [...host.querySelectorAll("label")].find(
    (node) => node.textContent === label,
  )?.htmlFor;
  return document.getElementById(id ?? "");
}

async function choose(label: string, option: string) {
  await act(async () => field(label)?.click());
  const found = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (node) => node.textContent === option,
  );
  if (!found) throw new Error(`no ${option} option`);
  await act(async () => found.click());
}

function paste(label: string, text: string) {
  const input = field(label) as HTMLInputElement | null;
  if (!input) throw new Error(`no ${label} field`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("shows nothing when there are no providers and no saved key", async () => {
  const read = deferred<Settings>();
  const client = new QueryClient();
  deployment.get.mockReturnValue(read.promise);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <DeploymentModelSettings />
      </QueryClientProvider>,
    ),
  );
  expect(deployment.get).toHaveBeenCalledOnce();
  await act(async () => read.resolve(noProvidersOrKey));
  await act(flush);
  expect(client.isFetching()).toBe(0);
  expect(host.querySelector("form")).toBeNull();
});

it("offers to remove a saved key whose model no longer runs", async () => {
  deployment.get
    .mockResolvedValueOnce({ ...noProvidersOrKey, keySaved: true })
    .mockResolvedValue(noProvidersOrKey);
  deployment.update.mockResolvedValue(noProvidersOrKey);
  await render();
  expect(field("Provider")?.textContent).toContain("Default");
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(deployment.update).toHaveBeenCalledWith({ provider: null });
  await act(() => vi.waitFor(() => expect(host.querySelector("form")).toBeNull()));
});

it("keeps the saved key when only the model changes", async () => {
  deployment.get.mockResolvedValue(saved);
  deployment.update.mockResolvedValue({ ...saved, modelId: "large-model" });
  await render();
  expect(field("Provider")?.textContent).toContain("Example Provider");
  const key = field("API key") as HTMLInputElement;
  expect(key.placeholder).toBe("Saved");
  expect(key.required).toBe(false);
  await choose("Model", "Large");
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(deployment.update).toHaveBeenCalledWith({
    provider: "example-provider",
    modelId: "large-model",
  });
});

it("asks for a key for another provider and sends it once", async () => {
  deployment.get.mockResolvedValue(saved);
  deployment.update.mockResolvedValue({ ...saved, provider: "other-provider" });
  await render();
  await choose("Provider", "Other Provider");
  const key = field("API key") as HTMLInputElement;
  expect(key.required).toBe(true);
  expect(key.placeholder).toBe("");
  expect(field("Model")?.textContent).toContain("Other");
  await act(async () => paste("API key", " fake-admin-key "));
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(deployment.update).toHaveBeenCalledWith({
    provider: "other-provider",
    modelId: "other-model",
    apiKey: "fake-admin-key",
  });
});

it("goes back to the server's own model", async () => {
  deployment.get.mockResolvedValue(saved);
  deployment.update.mockResolvedValue({ ...saved, provider: null, modelId: null, keySaved: false });
  await render();
  await choose("Provider", "Default");
  expect(field("API key")).toBeNull();
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(deployment.update).toHaveBeenCalledWith({ provider: null });
});

it("says why the settings were not saved", async () => {
  deployment.get.mockResolvedValue(saved);
  deployment.update.mockRejectedValue({ code: "INTERNAL_SERVER_ERROR" });
  await render();
  await choose("Model", "Large");
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not save model settings");
});
