import { deferred } from "@rakazo/core/test-async";
import { beforeEach, expect, it, vi } from "vitest";
import { isVerifiedScopeCurrent, verifiedScope } from "./verified-scope";

const state = vi.hoisted(() => ({
  base: "https://api.example.test",
  space: "space-a",
  generation: 0,
  rpc: vi.fn(),
  save: vi.fn(),
}));
vi.mock("./api", () => ({
  currentApiBase: () => state.base,
  selectedSpaceId: () => state.space,
  rpc: state.rpc,
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => state.generation,
  saveVerifiedScope: state.save,
}));

beforeEach(() => {
  state.base = "https://api.example.test";
  state.space = "space-a";
  state.generation += 1;
  state.save.mockReset().mockResolvedValue(undefined);
  state.rpc.mockReset().mockResolvedValue({ userId: "user-a", spaceId: "space-a" });
});

it("reuses verified identity until the session changes", async () => {
  const first = await verifiedScope();
  state.space = "space-b";
  expect((await verifiedScope()).spaceId).toBe("space-b");
  expect(state.rpc).toHaveBeenCalledTimes(2);
  expect(isVerifiedScopeCurrent(first)).toBe(false);
  state.generation += 1;
  state.rpc.mockResolvedValue({ userId: "user-b", spaceId: "space-b" });
  expect((await verifiedScope()).userId).toBe("user-b");
  expect(state.rpc).toHaveBeenCalledTimes(3);
});

it.each(["session", "space"])("rejects identity that returns after a %s change", async (change) => {
  const held = deferred<unknown>();
  state.rpc.mockReturnValue(held.promise);
  const pending = verifiedScope();
  if (change === "session") state.generation += 1;
  else state.space = "space-b";
  held.resolve({ userId: "user-a", spaceId: "space-a" });
  await expect(pending).rejects.toThrow();
});

it("persists a scope only after successful identity verification", async () => {
  const verified = await verifiedScope();
  expect(state.save).toHaveBeenCalledWith(state.generation, verified);
  state.generation += 1;
  state.rpc.mockRejectedValue(new Error("offline"));
  await expect(verifiedScope()).rejects.toThrow("offline");
  expect(state.save).toHaveBeenCalledTimes(1);
});
