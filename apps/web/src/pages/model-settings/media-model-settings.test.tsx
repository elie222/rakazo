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
vi.mock("@rakazo/ui-web", () => ({
  SectionHeading: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
  OptionSelect: ({
    value,
    options,
    disabled,
    onValueChange,
    "aria-label": label,
  }: {
    value: string | null;
    options: Array<{ value: string; label: string }>;
    disabled: boolean;
    onValueChange: (value: string) => void;
    "aria-label": string;
  }) => (
    <select
      aria-label={label}
      disabled={disabled}
      value={value ?? ""}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const images: MediaModelsView = {
  image: {
    options: [
      { credentialId: "key", modelId: "lab/draw", label: "Draw" },
      { credentialId: "key", modelId: "lab/sketch", label: "Sketch" },
    ],
    selected: { credentialId: "key", modelId: "lab/draw" },
  },
  video: { options: [], selected: null },
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  expect(host.querySelector('[aria-label="Video model"]')).toBeNull();
  const select = host.querySelector<HTMLSelectElement>('[aria-label="Image model"]')!;
  expect(select.selectedOptions[0]?.textContent).toBe("Draw");
  await act(async () => {
    select.value = JSON.stringify(["key", "lab/sketch"]);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(flush);
  expect(models.setMedia).toHaveBeenCalledWith(
    expect.objectContaining({ role: "image", credentialId: "key", modelId: "lab/sketch" }),
  );
});
