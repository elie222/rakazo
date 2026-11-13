import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { benchmarkEnvironment, stopProcess } from "./cli/performance-stack.js";

describe("benchmarkEnvironment", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("disables inherited billing configuration without changing the parent environment", () => {
    const billing = {
      STRIPE_SECRET_KEY: "sk_test_benchmark_placeholder",
      STRIPE_WEBHOOK_SECRET: "whsec_benchmark_placeholder",
      STRIPE_PRICE_ID: "price_benchmark_placeholder",
    };
    for (const [name, value] of Object.entries(billing)) vi.stubEnv(name, value);
    const env = benchmarkEnvironment({
      databaseUrl: "postgres://benchmark:benchmark@127.0.0.1:5432/benchmark",
      webPort: 5173,
      apiPort: 3000,
      dataDir: "/tmp/benchmark-data",
    });
    expect(env).toMatchObject({
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      STRIPE_PRICE_ID: "",
      AGENT_RUNTIME: "scripted",
      SIGNUPS_ENABLED: "true",
    });
    expect(process.env).toMatchObject(billing);
  });
});

describe("stopProcess", () => {
  it("returns for a child that exited normally", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(child, "exit");
    expect(child.exitCode).toBe(0);
    await stopProcess(child);
  });

  it("returns for a child that was already terminated by a signal", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await once(child, "spawn");
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe("SIGTERM");
    await stopProcess(child);
  }, 4_000);

  it("allows concurrent and repeated cleanup of a running child", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await once(child, "spawn");
    const setTimer = vi.spyOn(globalThis, "setTimeout");
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");
    try {
      await Promise.all([stopProcess(child), stopProcess(child)]);
      expect(child.signalCode).toBe("SIGTERM");
      expect(child.listenerCount("exit")).toBe(0);
      const timeoutIndices = setTimer.mock.calls.flatMap((args, index) =>
        args[1] === 5_000 ? [index] : [],
      );
      expect(timeoutIndices).toHaveLength(2);
      for (const index of timeoutIndices) {
        expect(clearTimer).toHaveBeenCalledWith(setTimer.mock.results[index]?.value);
      }
      await stopProcess(child);
    } finally {
      setTimer.mockRestore();
      clearTimer.mockRestore();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 4_000);

  it.skipIf(process.platform === "win32")(
    "kills a child that ignores SIGTERM",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)",
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      try {
        await once(child, "message");
        await stopProcess(child);
        expect(child.signalCode).toBe("SIGKILL");
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
    10_000,
  );
});
