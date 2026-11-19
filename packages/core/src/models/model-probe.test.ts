import { describe, expect, it, vi } from "vitest";
import { deferred } from "../primitives/async.test-support.js";
import {
  compatibleModelDiscovery,
  createModelProbe,
  initialModelProbeState,
  sameCompatibleModelEndpoint,
} from "./model-probe.js";

describe("automatic compatible model discovery", () => {
  const baseUrl = "https://models.example.test/v1";
  const draft = { baseUrl, apiKey: "", apiProtocol: "chat-completions", headerRows: null } as const;
  const preset = { name: "Hosted models", baseUrl };

  it("recognizes edits that keep a key on the same normalized endpoint", () => {
    expect(sameCompatibleModelEndpoint("https://models.example.test", baseUrl + "/")).toBe(true);
    expect(sameCompatibleModelEndpoint(baseUrl, "https://models.example.test/v2")).toBe(false);
    expect(sameCompatibleModelEndpoint(baseUrl, "https://")).toBe(false);
  });

  it("loads a public catalog without sending the typed key", () => {
    expect(
      compatibleModelDiscovery({
        ...draft,
        apiKey: "fake-key",
        preset: { ...preset, publicModels: true },
      }),
    ).toMatchObject({ baseUrl, apiKey: undefined });
  });

  it("waits for a hosted key unless the same endpoint already has a saved one", () => {
    expect(compatibleModelDiscovery({ ...draft, preset })).toBeNull();
    expect(compatibleModelDiscovery({ ...draft, preset, apiKey: " fake-key " })).toMatchObject({
      apiKey: "fake-key",
    });
    const credential = { id: "fixture", hasKey: true, baseUrl };
    expect(compatibleModelDiscovery({ ...draft, preset, credential })).toMatchObject({
      credentialId: "fixture",
      apiKey: undefined,
    });
    expect(
      compatibleModelDiscovery({
        ...draft,
        preset,
        credential: { ...credential, baseUrl: "https://old.example.test/v1" },
      }),
    ).toBeNull();
  });

  it("probes a keyless custom server once the URL and headers are ready", () => {
    expect(compatibleModelDiscovery({ ...draft, baseUrl: "https://" })).toBeNull();
    expect(
      compatibleModelDiscovery({ ...draft, headerRows: [{ name: "", value: "" }] }),
    ).toBeNull();
    expect(compatibleModelDiscovery(draft)).toMatchObject({ baseUrl, apiKey: undefined });
  });
});

function setup() {
  const onChange = vi.fn();
  const onSuccess = vi.fn();
  const onError = vi.fn();
  const controller = createModelProbe(onChange);
  const input = {
    baseUrl: " https://models.example.test/v1 ",
    apiKey: " fake-key ",
    onSuccess,
    onError,
  };
  return { controller, input, onChange, onSuccess, onError };
}

describe("model probe lifecycle", () => {
  it("normalizes the connection and treats an empty catalog as a successful manual-entry probe", async () => {
    const { controller, input, onChange, onSuccess } = setup();
    const request = vi.fn().mockResolvedValue({ models: [] });
    await controller.probe({ ...input, request });
    expect(request).toHaveBeenCalledWith({
      baseUrl: "https://models.example.test/v1",
      apiKey: "fake-key",
    });
    expect(onChange.mock.calls).toEqual([
      [{ models: [], baseUrl: null, probing: true }],
      [{ models: [], baseUrl: "https://models.example.test/v1", probing: false }],
    ]);
    expect(onSuccess).toHaveBeenCalledWith([]);
  });

  it.each(["provider", "key", "URL"])("ignores a result after the %s changes", async () => {
    const { controller, input, onChange, onSuccess, onError } = setup();
    const pending = deferred<{ models: string[] }>();
    const probe = controller.probe({ ...input, request: () => pending.promise });
    controller.reset();
    pending.resolve({ models: ["old-model"] });
    await probe;
    expect(onChange).toHaveBeenLastCalledWith(initialModelProbeState);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not report errors or update state after unmount", async () => {
    const { controller, input, onChange, onError } = setup();
    const pending = deferred<{ models: string[] }>();
    const probe = controller.probe({ ...input, request: () => pending.promise });
    controller.invalidate();
    pending.reject(new Error("old failure"));
    await probe;
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not let an older request finish a newer request", async () => {
    const { controller, input, onChange, onSuccess } = setup();
    const old = deferred<{ models: string[] }>();
    const current = deferred<{ models: string[] }>();
    const first = controller.probe({ ...input, request: () => old.promise });
    const second = controller.probe({ ...input, request: () => current.promise });
    old.resolve({ models: ["old-model"] });
    await first;
    expect(onChange).toHaveBeenLastCalledWith({ models: [], baseUrl: null, probing: true });
    expect(onSuccess).not.toHaveBeenCalled();
    current.resolve({ models: ["current-model"] });
    await second;
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith(["current-model"]);
  });

  it("clears probing after failure and omits a blank key", async () => {
    const { controller, input, onChange, onError } = setup();
    const error = new Error("unreachable");
    const request = vi.fn().mockRejectedValue(error);
    await controller.probe({ ...input, apiKey: "  ", request });
    expect(request).toHaveBeenCalledWith({
      baseUrl: "https://models.example.test/v1",
      apiKey: undefined,
    });
    expect(onChange).toHaveBeenLastCalledWith(initialModelProbeState);
    expect(onError).toHaveBeenCalledWith(error);
  });
});
