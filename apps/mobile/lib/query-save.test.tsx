// @vitest-environment jsdom
import { deferred, flush } from "@rakazo/core/test-async";
import { useQuery } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveSend } from "./query";
import { queryClient, rpcQuery, useSave } from "./query";
import type { SettingsTarget } from "./settings-target";

const scope = vi.hoisted(() => ({
  spaceId: "space-a",
  generation: 1,
  rpc: vi.fn(),
  /** Stands in for the context a save pins, when a test needs one that is not the current one. */
  pinned: undefined as unknown,
}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => scope.spaceId,
  captureApiRequestContext: async (spaceId: string | null = scope.spaceId) =>
    scope.pinned ?? {
      apiBase: "https://app.example.test",
      sessionGeneration: scope.generation,
      headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
    },
  rpc: scope.rpc,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => scope.generation }));

const save = vi.fn<(name: string, send: SaveSend) => Promise<string>>();
const onSaved = vi.fn();
const onFailed = vi.fn();
let closesScreen = false;
let target: SettingsTarget | undefined;
let screen: ReturnType<typeof useSave<string, string>> & { name: unknown };
function Screen() {
  const read = rpcQuery("voice/status");
  const { data } = useQuery(read, queryClient);
  screen = {
    ...useSave({ save, stale: [read.queryKey], onSaved, onFailed, closesScreen, target }),
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
  scope.generation = 1;
  scope.pinned = undefined;
  target = undefined;
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
  await act(flush);
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
  expect(save.mock.calls).toEqual([["After", expect.any(Function)]]);
  await act(async () => saving.resolve("After"));
  await settle();
  expect(onSaved.mock.calls).toEqual([["After", "After"]]);
  await act(async () => screen.run("Again"));
  expect(save).toHaveBeenLastCalledWith("Again", expect.any(Function));
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
    expect(save).toHaveBeenLastCalledWith("Here", expect.any(Function));
    await act(async () => finish(saving));
    await settle();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    expect(screen.pending).toBe(true);
    expect(screen.error).toBeNull();
    expect(screen.input).toBe("Here");
  },
);

it("picks up a save again when its space is selected again before it ends", async () => {
  const saving = deferred<string>();
  save.mockReturnValue(saving.promise);
  await act(async () => screen.run("After"));
  scope.spaceId = "space-b";
  await act(async () => root.render(<Screen />));
  scope.spaceId = "space-a";
  await act(async () => root.render(<Screen />));
  expect(screen.pending).toBe(true);
  act(() => screen.run("Twice"));
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => saving.resolve("After"));
  await settle();
  expect(onSaved.mock.calls).toEqual([["After", "After"]]);
});

const write = ["spaceSettings/setOverride", { setting: "voice", enabled: true }] as const;
const writes = (name: string, send: SaveSend) => send(...write).then(() => name);
const sent = () => scope.rpc.mock.calls.filter(([proc]) => proc === write[0]);

const named: SettingsTarget = { scope: "space", spaceId: "space-named" };
const account: SettingsTarget = { scope: "account" };
const targets = [
  ["a named Space", named],
  ["the account", account],
] as const;
/** The context a write carries: the server and session of the tap, and the Space it names. */
const pinnedTo = (spaceId: string, sessionGeneration = 1) => ({
  requestContext: {
    apiBase: "https://app.example.test",
    sessionGeneration,
    headers: { "x-rakazo-space-id": spaceId },
  },
});

describe.each(targets)("a save for %s", (_name, saveTarget) => {
  beforeEach(async () => {
    target = saveTarget;
    await act(async () => root.render(<Screen />));
  });

  it.each(outcomes)(
    "stays pending, takes no other save and reports when it %s after another space was selected",
    async (outcome, finish) => {
      const saving = deferred<string>();
      save.mockReturnValue(saving.promise);
      await act(async () => screen.run("After"));
      scope.spaceId = "space-b";
      await act(async () => root.render(<Screen />));
      expect(screen.pending).toBe(true);
      act(() => screen.run("Twice"));
      expect(save).toHaveBeenCalledTimes(1);

      await act(async () => finish(saving));
      await settle();
      expect(screen.pending).toBe(false);
      if (outcome === "succeeds") {
        expect(onSaved.mock.calls).toEqual([["After", "After"]]);
        expect(screen.error).toBeNull();
      } else {
        expect(onFailed.mock.calls).toEqual([[new Error("late"), "After"]]);
        expect(screen.error).toEqual(new Error("late"));
      }
    },
  );

  it("sends nothing once the session it was started in has ended", async () => {
    const prompt = deferred<void>();
    save.mockImplementation(async (name, send) => {
      await prompt.promise;
      return writes(name, send);
    });
    await act(async () => screen.run("After"));
    scope.generation = 2;
    await act(async () => prompt.resolve());
    await settle();
    expect(sent()).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });
});

it("sends every write with the context pinned at the tap, whatever the save is for", async () => {
  save.mockImplementation(writes);
  await act(async () => screen.run("After"));
  await settle();
  expect(sent()).toEqual([[...write, pinnedTo("space-a")]]);

  // An account save is sent with the Space selected at the tap, which its scope leaves out.
  target = account;
  await act(async () => root.render(<Screen />));
  await act(async () => screen.run("After"));
  await settle();
  expect(sent()[1]).toEqual([...write, pinnedTo("space-a")]);

  target = named;
  await act(async () => root.render(<Screen />));
  await act(async () => screen.run("After"));
  await settle();
  expect(sent()[2]).toEqual([...write, pinnedTo("space-named")]);
});

it("pins the context when the save starts, not when it sends", async () => {
  const prompt = deferred<void>();
  save.mockImplementation(async (name, send) => {
    await prompt.promise;
    return writes(name, send);
  });
  target = account;
  await act(async () => root.render(<Screen />));
  await act(async () => screen.run("After"));
  scope.spaceId = "space-b";
  await act(async () => prompt.resolve());
  await settle();
  expect(sent()).toEqual([[...write, pinnedTo("space-a")]]);
  expect(onSaved.mock.calls).toEqual([["After", "After"]]);
});

it.each([
  ["server", { ...pinnedTo("space-a").requestContext, apiBase: "https://other.example.test" }],
  ["session", pinnedTo("space-a", 2).requestContext],
  ["Space", pinnedTo("space-b").requestContext],
])("sends nothing with a context for another %s than the save's own", async (_part, context) => {
  scope.pinned = context;
  save.mockImplementation(writes);
  await act(async () => screen.run("After"));
  await settle();
  expect(sent()).toEqual([]);
  expect(screen.error).toEqual(new Error("Something went wrong. Try again."));
});

it("reports a save whose context could not be pinned, and sends nothing", async () => {
  scope.pinned = Promise.reject(new Error("The server changed while starting the request"));
  save.mockImplementation(writes);
  await act(async () => screen.run("After"));
  await settle();
  expect(sent()).toEqual([]);
  expect(screen.error).toEqual(new Error("The server changed while starting the request"));
});

it("sends nothing to the space selected after the save started", async () => {
  const prompt = deferred<void>();
  save.mockImplementation(async (name, send) => {
    await prompt.promise;
    return writes(name, send);
  });
  await act(async () => screen.run("After"));
  scope.spaceId = "space-b";
  await act(async () => prompt.resolve());
  await settle();
  expect(sent()).toEqual([]);
});

it.each(outcomes)(
  "shows nothing for a save that %s after the screen moved to another named Space",
  async (_outcome, finish) => {
    target = named;
    await act(async () => root.render(<Screen />));
    const saving = deferred<string>();
    save.mockReturnValue(saving.promise);
    await act(async () => screen.run("After"));
    target = { scope: "space", spaceId: "space-other" };
    await act(async () => root.render(<Screen />));
    expect(screen.pending).toBe(false);
    await act(async () => finish(saving));
    await settle();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    expect(screen.error).toBeNull();
  },
);
