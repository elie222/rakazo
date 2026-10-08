import { describe, expect, it } from "vitest";
import {
  deliverFinishedShells,
  formatFinishedShellCommand,
  isRunningShellCommand,
  observeShellCommand,
  SHELL_STILL_RUNNING_NOTICE,
} from "./shell-command-stream.js";

describe("observeShellCommand", () => {
  it("redacts provider errors before they reach the runtime", async () => {
    const secret = "fake-shell-error-secret";
    const error = await observeShellCommand(
      (async function* () {
        yield { type: "stdout" as const, data: "starting" };
        throw new Error(`Provider failed with ${secret}`, { cause: new Error(secret) });
      })(),
      { secrets: [secret] },
    ).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Provider failed with [redacted]");
    expect((error as Error).stack).not.toContain(secret);
    expect((error as Error).cause).toBeUndefined();
  });

  it("returns a fast command only after it exits", async () => {
    const seen: string[] = [];
    const observed = await observeShellCommand(
      (async function* () {
        yield { type: "stdout" as const, data: "hello\n" };
        yield { type: "exit" as const, code: 0 };
      })(),
      {
        secrets: [],
        idleMs: 30,
        onOutput: (snapshot) => {
          seen.push(snapshot.stdout);
        },
      },
    );

    expect(seen).toEqual(["hello\n"]);
    expect(observed.completion).toBeUndefined();
    expect(observed.result).toEqual({ stdout: "hello\n", stderr: "", code: 0 });
  });

  it("returns output and redacts secrets before the command exits", async () => {
    let releaseExit: () => void = () => undefined;
    const exitGate = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    let sawOutputBeforeExit = false;
    const observedPromise = observeShellCommand(
      (async function* () {
        yield {
          type: "stdout" as const,
          data: "code: ABCD-1234\nhttps://github.com/login/device\n",
        };
        yield { type: "stderr" as const, data: "token super-secret-token\n" };
        await exitGate;
        sawOutputBeforeExit = true;
        yield { type: "stdout" as const, data: "logged in\n" };
        yield { type: "exit" as const, code: 0 };
      })(),
      {
        secrets: ["super-secret-token"],
        idleMs: 20,
      },
    );

    const observed = await observedPromise;
    expect(sawOutputBeforeExit).toBe(false);
    expect(observed.result).toMatchObject({ code: null, running: true });
    expect(observed.result.stdout).toContain("ABCD-1234");
    expect(observed.result.stdout).toContain("https://github.com/login/device");
    expect(observed.result.stderr).not.toContain("super-secret-token");
    expect(observed.result.stderr).toContain("[redacted]");
    expect(observed.completion).toBeDefined();

    releaseExit();
    const final = await observed.completion;
    expect(final).toMatchObject({ code: 0 });
    expect(final?.stdout).toContain("logged in");
    expect(final?.stdout).toContain("ABCD-1234");
    expect(`${final?.stdout}${final?.stderr}`).not.toContain("super-secret-token");
  });

  it("redacts a secret split across chunks before returning it", async () => {
    let releaseExit: () => void = () => undefined;
    const exitGate = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    const seen: string[] = [];
    const observed = await observeShellCommand(
      (async function* () {
        yield { type: "stdout" as const, data: "prefix super-" };
        yield { type: "stdout" as const, data: "secret-token suffix\n" };
        await exitGate;
        yield { type: "exit" as const, code: 0 };
      })(),
      {
        secrets: ["super-secret-token"],
        idleMs: 20,
        onOutput: (snapshot) => {
          seen.push(snapshot.stdout);
        },
      },
    );

    expect(seen[0]).not.toContain("super-");
    expect(seen.at(-1)).toBe("prefix [redacted] suffix\n");
    expect(observed.result.stdout).toBe("prefix [redacted] suffix\n");
    expect(observed.result.stdout).not.toContain("super-secret-token");
    releaseExit();
    await observed.completion;
  });

  it("withholds a stdout secret prefix when stderr has unrelated text", async () => {
    let releaseExit: () => void = () => undefined;
    const exitGate = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    const seen: Array<{ stdout: string; stderr: string }> = [];
    const observed = await observeShellCommand(
      (async function* () {
        yield { type: "stdout" as const, data: "prefix super-" };
        yield { type: "stderr" as const, data: "unrelated noise" };
        await exitGate;
        yield { type: "exit" as const, code: 0 };
      })(),
      {
        secrets: ["super-secret-token"],
        idleMs: 20,
        onOutput: (snapshot) => {
          seen.push({ stdout: snapshot.stdout, stderr: snapshot.stderr });
        },
      },
    );

    expect(isRunningShellCommand(observed.result)).toBe(true);
    expect(observed.result.stdout).toBe("prefix ");
    expect(observed.result.stderr).toBe("unrelated noise");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((snapshot) => !snapshot.stdout.includes("super-"))).toBe(true);
    expect(seen.some((snapshot) => snapshot.stderr === "unrelated noise")).toBe(true);
    releaseExit();
    await observed.completion;
  });

  it("withholds a secret prefix from the still-running result", async () => {
    let releaseExit: () => void = () => undefined;
    const exitGate = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    const observed = await observeShellCommand(
      (async function* () {
        yield { type: "stdout" as const, data: "prefix super-" };
        await exitGate;
        yield { type: "stdout" as const, data: "secret-token suffix\n" };
        yield { type: "exit" as const, code: 0 };
      })(),
      { secrets: ["super-secret-token"], idleMs: 20 },
    );

    expect(isRunningShellCommand(observed.result)).toBe(true);
    expect(observed.result.stdout).toBe("prefix ");
    expect(observed.result.stdout).not.toContain("super-");
    releaseExit();
    const final = await observed.completion;
    expect(final?.stdout).toBe("prefix [redacted] suffix\n");
    expect(final?.stdout).not.toContain("super-secret-token");
  });

  it("withholds an incomplete secret split across stdout and stderr while running", async () => {
    let releaseExit: () => void = () => undefined;
    const exitGate = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    const seen: string[] = [];
    const observed = await observeShellCommand(
      (async function* () {
        yield { type: "stdout" as const, data: "ABCDE" };
        yield { type: "stderr" as const, data: "FGH" };
        await exitGate;
        yield { type: "exit" as const, code: 0 };
      })(),
      {
        secrets: ["ABCDEFGHIJ"],
        idleMs: 20,
        onOutput: (snapshot) => {
          seen.push(`${snapshot.stdout}${snapshot.stderr}`);
        },
      },
    );

    expect(isRunningShellCommand(observed.result)).toBe(true);
    expect(`${observed.result.stdout}${observed.result.stderr}`).toBe("");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((line) => !line.includes("ABCDE") && !line.includes("FGH"))).toBe(true);
    releaseExit();
    const final = await observed.completion;
    expect(`${final?.stdout}${final?.stderr}`).toBe("ABCDEFGH");
  });

  it("redacts a secret split across stdout and stderr before it is joined", async () => {
    const seen: string[] = [];
    const observed = await observeShellCommand(
      (async function* () {
        yield { type: "stdout" as const, data: "pre SECR" };
        yield { type: "stderr" as const, data: "ET123 post" };
        yield { type: "exit" as const, code: 0 };
      })(),
      {
        secrets: ["SECRET123"],
        idleMs: 30,
        onOutput: (snapshot) => {
          seen.push(`${snapshot.stdout}${snapshot.stderr}`);
        },
      },
    );

    const joined = `${observed.result.stdout}${observed.result.stderr}`;
    expect(joined).toBe("pre [redacted] post");
    expect(joined).not.toContain("SECRET123");
    expect(seen.every((line) => !line.includes("SECRET123"))).toBe(true);
  });
});

describe("deliverFinishedShells", () => {
  it("waits until the command exits, then hands the bot the final output", async () => {
    let release: (result: { stdout: string; stderr: string; code: number }) => void = () =>
      undefined;
    const completion = new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      release = resolve;
    });
    const pending = [completion];
    const followUps: string[] = [];
    const delivering = deliverFinishedShells((text) => followUps.push(text), pending, {
      toolResults: [],
    });

    await Promise.resolve();
    expect(followUps).toEqual([]);
    expect(pending).toEqual([]);

    release({ stdout: "logged in\n", stderr: "", code: 0 });
    await delivering;
    expect(followUps).toEqual([
      formatFinishedShellCommand({ stdout: "logged in\n", stderr: "", code: 0 }),
    ]);
    expect(followUps[0]).toContain("exit code: 0");
    expect(followUps[0]).toContain("logged in");
  });

  it("does not wait on the turn that first received the live output", async () => {
    let release: (result: { stdout: string; stderr: string; code: number }) => void = () =>
      undefined;
    const completion = new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      release = resolve;
    });
    const pending = [completion];
    const followUps: string[] = [];
    await deliverFinishedShells((text) => followUps.push(text), pending, {
      toolResults: [
        {
          toolName: "shell",
          details: {
            stdout: "code: ABCD-1234\n",
            stderr: "",
            code: null,
            running: true,
            notice: SHELL_STILL_RUNNING_NOTICE,
          },
        },
      ],
    });

    expect(followUps).toEqual([]);
    expect(pending).toHaveLength(1);
    release({ stdout: "ok\n", stderr: "", code: 0 });
    await deliverFinishedShells((text) => followUps.push(text), pending, { toolResults: [] });
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toContain("exit code: 0");
  });
});
