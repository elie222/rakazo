// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import type { MediaModelsView } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MediaModelSettings } from "./media-model-settings";

const models = vi.hoisted(() => ({ media: vi.fn(), setMedia: vi.fn() }));
vi.mock("../../lib/query/rpc", () => {
  const rpc = { models };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => "s" };
});
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: string[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));

const images: MediaModelsView = {
  image: {
    options: [
      {
        credentialId: "key",
        modelId: "lab/draw",
        label: "Draw",
        provider: "lab",
        connectionLabel: "Work",
      },
      {
        credentialId: "key",
        modelId: "lab/sketch",
        label: "Sketch",
        provider: "lab",
        connectionLabel: "Work",
      },
    ],
    selected: { credentialId: "key", modelId: "lab/draw" },
  },
  video: { options: [], selected: null },
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
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
  Element.prototype.scrollIntoView = () => undefined;
  i18n.load("en", {});
  i18n.activate("en");
  notifyManager.setScheduler((callback) => callback());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("offers only the media a connection makes, and saves the chosen model", async () => {
  models.media.mockResolvedValue(images);
  models.setMedia.mockResolvedValue({
    ...images,
    image: { ...images.image, selected: { credentialId: "key", modelId: "lab/sketch" } },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MediaModelSettings userId="u" spaceId="s" scope="account" connectionIds={["key"]} />
      </QueryClientProvider>,
    );
  });
  await act(flush);
  expect(host.querySelector('[data-testid="model-role-video"]')).toBeNull();
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Change Image model"]')!;
  expect(trigger.textContent).toBe("DrawWork");
  await act(async () => trigger.click());
  const sketch = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (option) => option.textContent === "Sketch",
  );
  await act(async () => sketch!.click());
  await act(flush);
  expect(models.setMedia).toHaveBeenCalledWith(
    expect.objectContaining({ role: "image", credentialId: "key", modelId: "lab/sketch" }),
  );
});
