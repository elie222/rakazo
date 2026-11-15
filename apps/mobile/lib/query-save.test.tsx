// @vitest-environment jsdom
import { useQuery } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient, rpcQuery, useSave } from "./query";

const scope = vi.hoisted(() => ({ spaceId: "space-a", rpc: vi.fn() }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => scope.spaceId,
  captureApiRequestContext: async () => ({ apiBase: "https://app.example.test", headers: {} }),
  rpc: scope.rpc,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const save = vi.fn<(name: string) => Promise<string>>();
const onSaved = vi.fn();
const onFailed = vi.fn();
let closesScreen = false;
let screen: ReturnType<typeof useSave<string, string>> & { name: unknown };
function Screen() {
  const read = rpcQuery("voice/status");
  const { data } = useQuery(read, queryClient);
  screen = {
    ...useSave({ save, stale: [read.queryKey], onSaved, onFailed, closesScreen }),
    name: data,
  };
  return null;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  scope.spaceId = "space-a";
  scope.rpc.mockReset().mockResolvedValue("Before");
  save.mockReset();
  onSaved.mockReset();
  onFailed.mockReset();
  closesScreen = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Screen />));
  await settle();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
const cached = () => queryClient.getQueryState(rpcQuery("voice/status").queryKey);

it("keeps a save that succeeded when the read after it fails", async () => {
  save.mockImplementation(async (name) => {
    queryClient.setQueryData(rpcQuery("voice/status").queryKey, name as never);
    return name;
  });
  scope.rpc.mockRejectedValue(new Error("offline"));
  await act(async () => screen.run("After"));
  await settle();
  expect(screen.error).toBeNull();
  expect(screen.pending).toBe(false);
  expect(onSaved).toHaveBeenCalledWith("After", "After");
  expect(screen.name).toBe("After");
  expect(cached()?.isInvalidated).toBe(true);
  expect(cached()?.error).toEqual(new Error("offline"));
});

it("stays pending until the stale reads are back", async () => {
  const reread = deferred<string>();
  save.mockResolvedValue("After");
  scope.rpc.mockReturnValue(reread.promise);
  await act(async () => screen.run("After"));
  await settle();
  expect(screen.pending).toBe(true);
  expect(screen.input).toBe("After");
  await act(async () => reread.resolve("After"));
  await settle();
  expect(screen.pending).toBe(false);
  expect(screen.name).toBe("After");
});

it("reports a save that failed and leaves the reads alone", async () => {
  save.mockRejectedValue(new Error("Name taken"));
  await act(async () => screen.run("After"));
  await settle();
  expect(screen.error).toEqual(new Error("Name taken"));
  expect(screen.input).toBe("After");
  expect(onSaved).not.toHaveBeenCalled();
  expect(onFailed.mock.calls).toEqual([[new Error("Name taken"), "After"]]);
  expect(cached()?.isInvalidated).toBe(false);
  expect(scope.rpc).toHaveBeenCalledTimes(1);
  await act(async () => screen.reset());
  await settle();
  expect(screen.error).toBeNull();
});

const outcomes = [
  ["succeeds", (saving: ReturnType<typeof deferred<string>>) => saving.resolve("After")],
  ["fails", (saving: ReturnType<typeof deferred<string>>) => saving.reject(new Error("late"))],
] as const;

it("is pending in the render that follows the call, with no tick in between", () => {
  save.mockReturnValue(deferred<string>().promise);
  act(() => screen.run("After"));
  expect(screen.pending).toBe(true);
  expect(screen.input).toBe("After");
});

it("runs one save when called twice in the same tick, and again once that one has ended", async () => {
  const saving = deferred<string>();
  save.mockReturnValueOnce(saving.promise).mockResolvedValue("Again");
  act(() => {
    screen.run("After");
    screen.run("Twice");
  });
  expect(save.mock.calls).toEqual([["After"]]);
  await act(async () => saving.resolve("After"));
  await settle();
  expect(onSaved.mock.calls).toEqual([["After", "After"]]);
  await act(async () => screen.run("Again"));
  expect(save).toHaveBeenLastCalledWith("Again");
});

it("stays pending after a save that closes the screen, and takes no other save", async () => {
  closesScreen = true;
  await act(async () => root.render(<Screen />));
  save.mockResolvedValue("After");
  await act(async () => screen.run("After"));
  await settle();
  expect(onSaved).toHaveBeenCalledWith("After", "After");
  expect(screen.pending).toBe(true);
  act(() => screen.run("Again"));
  expect(save).toHaveBeenCalledTimes(1);
});

it("offers a save that closes the screen again when it fails", async () => {
  closesScreen = true;
  await act(async () => root.render(<Screen />));
  save.mockRejectedValueOnce(new Error("Name taken")).mockResolvedValue("After");
  await act(async () => screen.run("After"));
  await settle();
  expect(screen.pending).toBe(false);
  expect(screen.error).toEqual(new Error("Name taken"));
  await act(async () => screen.run("After"));
  expect(save).toHaveBeenCalledTimes(2);
  expect(screen.error).toBeNull();
});

it.each(outcomes)(
  "ignores a save that %s after the screen has gone, but still marks its reads stale",
  async (outcome, finish) => {
    const saving = deferred<string>();
    save.mockReturnValue(saving.promise);
    await act(async () => screen.run("After"));
    await act(async () => root.render(null));
    await act(async () => finish(saving));
    await settle();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    expect(cached()?.isInvalidated).toBe(outcome === "succeeds");
  },
);

it.each(outcomes)(
  "shows nothing for a save that %s after the space changed, and saves in the new space meanwhile",
  async (_outcome, finish) => {
    const saving = deferred<string>();
    save.mockReturnValueOnce(saving.promise).mockReturnValue(deferred<string>().promise);
    await act(async () => screen.run("After"));
    scope.spaceId = "space-b";
    await act(async () => root.render(<Screen />));
    expect(screen.pending).toBe(false);
    await act(async () => screen.run("Here"));
    expect(save).toHaveBeenLastCalledWith("Here");
    await act(async () => finish(saving));
    await settle();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    expect(screen.pending).toBe(true);
    expect(screen.error).toBeNull();
    expect(screen.input).toBe("Here");
  },
);
