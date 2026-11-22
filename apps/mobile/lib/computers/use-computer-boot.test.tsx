// @vitest-environment jsdom

import type { ComputerStatus } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComputerBoot } from "./use-computer-boot";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("../api/api", () => ({ rpc }));

const running = { state: "running", controlHolder: "none" } as ComputerStatus;
const stopped = { ...running, state: "stopped" } as ComputerStatus;
let current: ReturnType<typeof useComputerBoot>;
let root: Root;

function Harness({ botId }: { botId?: string }) {
  current = useComputerBoot(botId);
  const controller = current.refreshController;
  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);
  return null;
}

async function render(botId = "bot-1") {
  await act(async () => root.render(createElement(Harness, { botId })));
}

async function poll() {
  await act(async () => vi.advanceTimersByTimeAsync(2000));
}

async function failBoot(error = new Error("Computer is busy")) {
  rpc.mockImplementationOnce(async () => {
    throw error;
  });
  await act(async () => {
    await expect(current.bootComputer({ takeControl: false, showProgress: true })).rejects.toBe(
      error,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  rpc.mockReset();
  rpc.mockImplementation(async (method: string) =>
    method === "computer/status" ? stopped : { url: "https://screen.example.test" },
  );
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("computer error recovery", () => {
  it.each([running, stopped])(
    "clears an initial read error after a successful $state status",
    async (status) => {
      rpc.mockRejectedValueOnce(Object.assign(new Error("Service failed"), { status: 500 }));
      await render();
      expect(current.error).toBeTruthy();
      rpc.mockResolvedValueOnce(status);
      await poll();
      expect(current.computer).toEqual(status);
      expect(current.error).toBeNull();
    },
  );

  it("keeps a read error through another failed read before recovery", async () => {
    rpc.mockRejectedValueOnce(new Error("Network request failed"));
    await render();
    const message = current.error;
    rpc.mockRejectedValueOnce(new Error("Network request failed"));
    await poll();
    expect(current.error).toBe(message);
    await poll();
    expect(current.error).toBeNull();
  });

  it("keeps a start error until another client starts the computer", async () => {
    await render();
    await failBoot();
    for (const state of ["stopped", "error"] as const) {
      rpc.mockResolvedValueOnce({ ...stopped, state });
      await poll();
      expect(current.error).toBe("Computer is busy");
      expect(current.bootFailed).toBe(true);
    }
    rpc.mockResolvedValueOnce(running);
    await poll();
    expect(current.error).toBeNull();
    expect(current.bootFailed).toBe(false);
    expect(current.screenUrl).toBe("https://screen.example.test");
  });

  it.each([
    new Error("Could not open computer"),
    Object.assign(new Error("Request timed out"), { name: "TimeoutError" }),
  ])("retains a takeover error after running status recovers: %s", async (error) => {
    rpc.mockResolvedValueOnce(running);
    await render();
    rpc.mockImplementationOnce(async () => {
      throw error;
    });
    await act(async () => {
      await expect(current.bootComputer({ takeControl: true, showProgress: true })).rejects.toBe(
        error,
      );
    });
    rpc.mockResolvedValueOnce(running);
    await poll();
    expect(current.computer?.state).toBe("running");
    expect(current.error).toBe(error.message);
    expect(current.bootFailed).toBe(false);
  });

  it("does not clear a newer explicit error when a read recovers", async () => {
    rpc.mockRejectedValueOnce(new Error("Network request failed"));
    await render();
    await act(async () => current.setError("Could not switch computer"));
    await poll();
    expect(current.error).toBe("Could not switch computer");
  });

  it("keeps an open error after a failed action refresh recovers", async () => {
    rpc.mockResolvedValueOnce(running);
    await render();
    const error = new Error("Could not open computer");
    rpc.mockRejectedValueOnce(error);
    await act(async () => {
      await expect(current.bootComputer({ takeControl: false, showProgress: false })).rejects.toBe(
        error,
      );
    });
    rpc.mockResolvedValueOnce(running);
    await poll();
    expect(current.error).toBe(error.message);
    expect(current.bootFailed).toBe(false);
    await act(async () => {
      expect(await current.bootComputer({ takeControl: false, showProgress: false })).toBe(true);
    });
    expect(current.error).toBeNull();
  });

  it("does not let a previous target's late status clear the new target's error", async () => {
    await render();
    await failBoot();
    const oldRead = deferred<ComputerStatus>();
    rpc.mockReturnValueOnce(oldRead.promise);
    await poll();
    rpc.mockRejectedValueOnce(new Error("Network request failed"));
    await render("bot-2");
    const message = current.error;
    expect(message).toBeTruthy();
    await act(async () => oldRead.resolve(running));
    expect(current.error).toBe(message);
    await poll();
    expect(current.error).toBeNull();
  });

  it("does not let an in-flight status clear a newer start failure", async () => {
    await render();
    const oldRead = deferred<ComputerStatus>();
    rpc.mockReturnValueOnce(oldRead.promise);
    await poll();
    await failBoot();
    await act(async () => oldRead.resolve(running));
    expect(current.error).toBe("Computer is busy");
    expect(current.bootFailed).toBe(true);
  });
});
