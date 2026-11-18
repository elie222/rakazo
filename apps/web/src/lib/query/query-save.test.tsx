// @vitest-environment jsdom
import { deferred, flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scope = vi.hoisted(() => ({
  selected: "space-a" as string | null,
  /** The space each write named, with what it sent. */
  writes: [] as [string | null, unknown][],
}));
vi.mock("./rpc", () => {
  const clientFor = (spaceId: string | null) => ({
    spaces: {
      rename: async (input: unknown) => {
        scope.writes.push([spaceId, input]);
      },
    },
  });
  return {
    rpc: clientFor(null),
    createSpaceRpc: clientFor,
    rpcForSpace: clientFor,
    selectedSpaceId: () => scope.selected,
  };
});

import { QueryUserProvider, useSave } from "./query";
import type { RpcClient } from "./rpc";
import { SpaceRpcProvider } from "./space-rpc";

const READ = ["space-name"];
const read = vi.fn<() => Promise<string>>();
const save = vi.fn<(name: string, rpc: RpcClient) => Promise<string>>();
const onSaved = vi.fn();
const onFailed = vi.fn();
let closesScreen = false;
let stale: Parameters<typeof useSave<string, string>>[0]["stale"] = [READ];
let userId = "user-a";
let boundSpaceId: string | null | undefined;
let screen: ReturnType<typeof useSave<string, string>> & { name: unknown };
function Screen() {
  const { data } = useQuery({ queryKey: READ, queryFn: read });
  screen = { ...useSave({ save, stale, onSaved, onFailed, closesScreen }), name: data };
  return null;
}

let client: QueryClient;
let container: HTMLDivElement;
let root: Root;
async function render(shown = true) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <QueryUserProvider value={userId}>
          <SpaceRpcProvider spaceId={boundSpaceId}>{shown ? <Screen /> : null}</SpaceRpcProvider>
        </QueryUserProvider>
      </QueryClientProvider>,
    ),
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  scope.selected = "space-a";
  scope.writes = [];
  userId = "user-a";
  boundSpaceId = undefined;
  closesScreen = false;
  stale = [READ];
  read.mockReset().mockResolvedValue("Before");
  save.mockReset();
  onSaved.mockReset();
  onFailed.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await render();
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
const cached = () => client.getQueryState(READ);
const writes = (name: string, rpc: RpcClient) =>
  rpc.spaces.rename({ spaceId: "space-renamed", name }).then(() => name);

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
  expect(save.mock.calls).toEqual([["After", expect.anything()]]);
  await act(async () => saving.resolve("After"));
  await settle();
  expect(onSaved.mock.calls).toEqual([["After", "After"]]);
  await act(async () => screen.run("Again"));
  expect(save).toHaveBeenLastCalledWith("Again", expect.anything());
});

it("keeps a save that succeeded when the read after it fails", async () => {
  save.mockResolvedValue("After");
  read.mockRejectedValue(new Error("offline"));
  await act(async () => screen.run("After"));
  await settle();
  expect(screen.error).toBeNull();
  expect(screen.pending).toBe(false);
  expect(onSaved).toHaveBeenCalledWith("After", "After");
  expect(onFailed).not.toHaveBeenCalled();
  expect(cached()?.isInvalidated).toBe(true);
  expect(cached()?.error).toEqual(new Error("offline"));
});

it("stays pending until the stale reads are back", async () => {
  const reread = deferred<string>();
  save.mockResolvedValue("After");
  read.mockReturnValue(reread.promise);
  await act(async () => screen.run("After"));
  await settle();
  expect(screen.pending).toBe(true);
  expect(onSaved).not.toHaveBeenCalled();
  await act(async () => reread.resolve("After"));
  await settle();
  expect(screen.pending).toBe(false);
  expect(screen.name).toBe("After");
});

it("reports a save that failed, leaves the reads alone, and forgets the failure on reset", async () => {
  save.mockRejectedValue(new Error("Name taken"));
  await act(async () => screen.run("After"));
  await settle();
  expect(screen.error).toEqual(new Error("Name taken"));
  expect(screen.input).toBe("After");
  expect(onSaved).not.toHaveBeenCalled();
  expect(onFailed.mock.calls).toEqual([[new Error("Name taken"), "After"]]);
  expect(cached()?.isInvalidated).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => screen.reset());
  expect(screen.error).toBeNull();
});

it("reports a save that throws before its first request", async () => {
  save.mockImplementation(() => {
    throw new Error("Nothing to save");
  });
  await act(async () => screen.run("After"));
  await settle();
  expect(screen.error).toEqual(new Error("Nothing to save"));
  expect(screen.pending).toBe(false);
});

it("clears the last failure when the next save starts", async () => {
  save.mockRejectedValueOnce(new Error("Name taken")).mockReturnValue(deferred<string>().promise);
  await act(async () => screen.run("After"));
  await settle();
  expect(screen.error).toEqual(new Error("Name taken"));
  act(() => screen.run("Again"));
  expect(screen.error).toBeNull();
});

it("stays pending after a save that closes the screen, and takes no other save", async () => {
  closesScreen = true;
  await render();
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
  await render();
  save.mockRejectedValueOnce(new Error("Name taken")).mockResolvedValue("After");
  await act(async () => screen.run("After"));
  await settle();
  expect(screen.pending).toBe(false);
  expect(screen.error).toEqual(new Error("Name taken"));
  await act(async () => screen.run("After"));
  expect(save).toHaveBeenCalledTimes(2);
});

it("gives the controls back, with the reason, when what follows a save that closes the screen fails", async () => {
  closesScreen = true;
  await render();
  save.mockResolvedValue("After");
  onSaved.mockRejectedValueOnce(new Error("Could not open it"));
  await act(async () => screen.run("After"));
  await settle();
  expect(screen.pending).toBe(false);
  expect(screen.error).toEqual(new Error("Could not open it"));
  await act(async () => screen.run("After"));
  expect(save).toHaveBeenCalledTimes(2);
});

it("reads again what the saved input makes out of date", async () => {
  const named = vi.fn((_input: string) => [READ]);
  stale = named;
  await render();
  save.mockResolvedValue("After");
  read.mockResolvedValue("After");
  await act(async () => screen.run("After"));
  await settle();
  expect(named).toHaveBeenCalledWith("After");
  expect(screen.name).toBe("After");
  expect(screen.pending).toBe(false);
});

describe("a save whose screen has gone", () => {
  it.each(outcomes)(
    "is ignored when it %s, but still marks its reads stale",
    async (outcome, finish) => {
      const saving = deferred<string>();
      save.mockReturnValue(saving.promise);
      await act(async () => screen.run("After"));
      await render(false);
      await act(async () => finish(saving));
      await settle();
      expect(onSaved).not.toHaveBeenCalled();
      expect(onFailed).not.toHaveBeenCalled();
      expect(cached()?.isInvalidated).toBe(outcome === "succeeds");
    },
  );

  it("still sends the requests it had not sent yet", async () => {
    const prompt = deferred<void>();
    save.mockImplementation(async (name, rpc) => {
      await prompt.promise;
      return writes(name, rpc);
    });
    await act(async () => screen.run("After"));
    await render(false);
    await act(async () => prompt.resolve());
    await settle();
    expect(scope.writes).toEqual([["space-a", { spaceId: "space-renamed", name: "After" }]]);
  });
});

describe("a save for the selected space", () => {
  it("writes to the space selected at the click, whatever is selected when the request leaves", async () => {
    const prompt = deferred<void>();
    save.mockImplementation(async (name, rpc) => {
      await prompt.promise;
      return writes(name, rpc);
    });
    await act(async () => screen.run("After"));
    scope.selected = "space-b";
    await act(async () => prompt.resolve());
    await settle();
    expect(scope.writes).toEqual([["space-a", { spaceId: "space-renamed", name: "After" }]]);
  });

  it("writes without naming a space when none is selected", async () => {
    scope.selected = null;
    await render();
    save.mockImplementation(writes);
    await act(async () => screen.run("After"));
    await settle();
    expect(scope.writes).toEqual([[null, { spaceId: "space-renamed", name: "After" }]]);
  });

  it.each(outcomes)(
    "shows nothing when it %s after another space was selected, and saves there meanwhile",
    async (_outcome, finish) => {
      const saving = deferred<string>();
      save.mockReturnValueOnce(saving.promise).mockReturnValue(deferred<string>().promise);
      await act(async () => screen.run("After"));
      scope.selected = "space-b";
      await render();
      expect(screen.pending).toBe(false);
      await act(async () => screen.run("Here"));
      expect(save).toHaveBeenLastCalledWith("Here", expect.anything());
      await act(async () => finish(saving));
      await settle();
      expect(onSaved).not.toHaveBeenCalled();
      expect(onFailed).not.toHaveBeenCalled();
      expect(screen.pending).toBe(true);
      expect(screen.error).toBeNull();
      expect(screen.input).toBe("Here");
    },
  );

  it("is picked up again when its space is selected again before it ends", async () => {
    const saving = deferred<string>();
    save.mockReturnValue(saving.promise);
    await act(async () => screen.run("After"));
    scope.selected = "space-b";
    await render();
    scope.selected = "space-a";
    await render();
    expect(screen.pending).toBe(true);
    act(() => screen.run("Twice"));
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => saving.resolve("After"));
    await settle();
    expect(onSaved.mock.calls).toEqual([["After", "After"]]);
  });
});

describe("a save for the space the screen is bound to", () => {
  beforeEach(async () => {
    boundSpaceId = "space-bound";
    await render();
  });

  it("writes to that space, not the selected one", async () => {
    save.mockImplementation(writes);
    await act(async () => screen.run("After"));
    await settle();
    expect(scope.writes).toEqual([["space-bound", { spaceId: "space-renamed", name: "After" }]]);
  });

  it.each(outcomes)(
    "stays pending, takes no other save and reports when it %s after another space was selected",
    async (outcome, finish) => {
      const saving = deferred<string>();
      save.mockReturnValue(saving.promise);
      await act(async () => screen.run("After"));
      scope.selected = "space-b";
      await render();
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

  it.each(outcomes)(
    "shows nothing when it %s after the screen was bound to another space",
    async (_outcome, finish) => {
      const saving = deferred<string>();
      save.mockReturnValue(saving.promise);
      await act(async () => screen.run("After"));
      boundSpaceId = "space-other";
      await render();
      expect(screen.pending).toBe(false);
      await act(async () => finish(saving));
      await settle();
      expect(onSaved).not.toHaveBeenCalled();
      expect(onFailed).not.toHaveBeenCalled();
      expect(screen.pending).toBe(false);
      expect(screen.error).toBeNull();
    },
  );
});

it.each(outcomes)(
  "shows nothing for a save that %s after another user signed in",
  async (_outcome, finish) => {
    const saving = deferred<string>();
    save.mockReturnValue(saving.promise);
    await act(async () => screen.run("After"));
    userId = "user-b";
    await render();
    expect(screen.pending).toBe(false);
    await act(async () => finish(saving));
    await settle();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    expect(screen.error).toBeNull();
  },
);
