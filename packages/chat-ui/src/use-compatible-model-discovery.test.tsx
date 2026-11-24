// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useCompatibleModelDiscovery } from "./use-compatible-model-discovery.js";

it("runs discovery again when a reload resets an unchanged endpoint", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const baseUrl = "https://models.example.test/v1";
  const request = vi
    .fn()
    .mockResolvedValueOnce({ models: ["first-model"] })
    .mockResolvedValueOnce({ models: ["reloaded-model"] });

  function Connection() {
    const { probeModels, resetOpenAiCompatibleProbe } = useCompatibleModelDiscovery(
      {
        baseUrl,
        apiKey: "",
        apiProtocol: "chat-completions",
        headerRows: null,
        preset: { name: "Fixture", baseUrl, publicModels: true },
      },
      { request, onModels: () => {}, errorMessage: String },
    );
    return (
      <button type="button" onClick={resetOpenAiCompatibleProbe}>
        {probeModels.join(", ")}
      </button>
    );
  }

  try {
    await act(async () => root.render(<Connection />));
    await act(async () => vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1)));
    expect(container.textContent).toBe("first-model");
    await act(async () => container.querySelector("button")?.click());
    await act(async () => vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2)));
    expect(container.textContent).toBe("reloaded-model");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
