import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SandboxState } from "@daytona/sdk";
import {
  DaytonaAuthenticationError,
  DaytonaConflictError,
  DaytonaError,
  DaytonaGoneError,
  DaytonaNotFoundError,
  DaytonaProcessExecutionTimeoutError,
  DaytonaRateLimitError,
  DaytonaTimeoutError,
} from "@daytona/sdk";
import type { PageBrowserCommand } from "@rakazo/adapter-kit";
import { SandboxRateLimitError, WorkspaceTooLargeError } from "@rakazo/adapter-kit";
import { shellQuote } from "@rakazo/core/node/desktop-runtime";
import { deferred } from "@rakazo/core/test-async";
import { parse } from "shell-quote";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installPageBrowserCommand } from "../../../browser/page-browser-install.js";
import { isSandboxGoneError } from "../../../computers/sandbox/sandbox-errors.js";
import {
  assertSandboxReadLimit,
  MachineRecords,
  settleMachineCleanup,
} from "../../../computers/sandbox/sandbox-test-support.js";
import { ComputerBrowserProvider } from "../../../computers/screens/computer-browser.js";
import type { DaytonaSandbox } from "./daytona-sandbox.js";
import { DaytonaSandboxProvider } from "./daytona-sandbox.js";
import { daytonaFixture } from "./daytona-sandbox.test-support.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

const temporaryRoots: string[] = [];

describe("DaytonaSandboxProvider", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("offers native page tools on the bot's existing desktop", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const browser = new ComputerBrowserProvider({ sandbox: provider });
    expect(browser.describe().capabilities.page).toBe(true);
  });

  it("fills on the existing screen using stdin after removing its private input", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "team-home", homePath: "/unused" }, context);
    await provider.prepare(computer, context);
    expect(
      fixture.executeCommand.mock.calls.some(
        ([command]) => parse(command).at(-1) === installPageBrowserCommand(),
      ),
    ).toBe(true);
    let inputFile = "";
    fixture.sandbox.fs.uploadFile.mockImplementation(async (content, target) => {
      inputFile = target;
      await writeFile(target, content, { mode: 0o600 });
    });
    const original = fixture.executeCommand.getMockImplementation()!;
    const run = promisify(execFile);
    const registry = await mkdtemp(path.join(tmpdir(), "daytona-page-test-"));
    temporaryRoots.push(registry);
    fixture.executeCommand.mockImplementation(async (command, cwd, env, timeout) => {
      if (!command.includes("/tmp/rakazo-page-input-")) return original(command, cwd, env, timeout);
      const helper = [
        "const fs = require('node:fs');",
        "const request = JSON.parse(fs.readFileSync(0, 'utf8'));",
        `if (fs.existsSync(${JSON.stringify(inputFile)}) || fs.existsSync(${JSON.stringify(inputFile.slice(0, inputFile.lastIndexOf("/")))})) process.exit(1);`,
        "console.log(JSON.stringify({ok:true,completed:request.actions.length,display:process.env.DISPLAY,port:process.env.RAKAZO_CDP_PORT}));",
      ].join("\n");
      const script = parse(command).at(-1);
      let actual =
        typeof script === "string" && command.startsWith("bash -c ")
          ? script.replace(
              "/usr/local/bin/rakazo-page-browser act",
              `node -e ${shellQuote(helper)}`,
            )
          : command;
      if (actual.includes("RAKAZO_BROWSER_ARGS_STDIN")) {
        const slot = actual.match(/slot="\$dir\/([^"/]+)"/)?.[1];
        if (!slot) throw new Error("Expected a fenced desktop command");
        await writeFile(
          path.join(registry, slot),
          `${actual.includes("DISPLAY=:20") ? 0 : 1}\n\nview\n`,
        );
        actual = actual.replaceAll("/tmp/rakazo/desktop-assignments", registry);
      }
      const result = await run("bash", ["-c", `flock() { :; }\n${actual}`]);
      return { exitCode: 0, result: result.stdout };
    });
    const request: PageBrowserCommand = {
      command: "act",
      actions: [
        {
          kind: "fill",
          ref: "e1",
          text: "fake-vault-password",
          origin: "https://example.com",
          field: "password",
        },
      ],
    };
    await provider.observe(computer, { ...context, botId: "writer" });
    await expect(
      provider.pageBrowser(computer, request, { ...context, botId: "writer" }),
    ).resolves.toMatchObject({ ok: true, completed: 1, display: ":20", port: "9241" });
    await expect(
      provider.pageBrowser(computer, request, { ...context, botId: "researcher" }),
    ).resolves.toMatchObject({ ok: true, completed: 1, display: ":21", port: "9242" });
    expect(new Set(fixture.sandbox.fs.uploadFile.mock.calls.map(([, target]) => target)).size).toBe(
      2,
    );
    expect(
      fixture.executeCommand.mock.calls.every(
        ([command]) => !command.includes("fake-vault-password"),
      ),
    ).toBe(true);
    expect(fixture.sandbox.fs.uploadFile).toHaveBeenCalledWith(
      Buffer.from(`${JSON.stringify(request)}\n`),
      inputFile,
      25,
    );
  });

  it.each([false, true])(
    "keeps desktop fallback when page installation fails (throws=%s)",
    async (throws) => {
      const fixture = daytonaFixture();
      const provider = new DaytonaSandboxProvider({}, fixture.client);
      const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
      const original = fixture.executeCommand.getMockImplementation()!;
      fixture.executeCommand.mockImplementation(async (command, cwd, env, timeout) => {
        if (parse(command).at(-1) === installPageBrowserCommand()) {
          if (throws) throw new Error("installer timed out");
          return { exitCode: 1, result: "installer unavailable" };
        }
        return original(command, cwd, env, timeout);
      });
      await expect(provider.prepare(computer, context)).resolves.toBeUndefined();
      await expect(provider.observe(computer, context)).resolves.toMatchObject({ width: 1280 });
    },
  );

  it.each(["upload", "execute", "cancel", "timeout"])(
    "cleans browser input after %s without replaying the action",
    async (failure) => {
      const fixture = daytonaFixture();
      const provider = new DaytonaSandboxProvider({}, fixture.client);
      const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
      const original = fixture.executeCommand.getMockImplementation()!;
      const controller = new AbortController();
      let dispatched = 0;
      let inputFile = "";
      fixture.sandbox.fs.uploadFile.mockImplementation(async (_content, target) => {
        inputFile = target;
        if (failure === "upload") throw new Error("fake-vault-password");
        if (failure === "cancel") controller.abort();
      });
      fixture.executeCommand.mockImplementation(async (command, cwd, env, timeout) => {
        if (command.includes("/usr/local/bin/rakazo-page-browser snapshot")) {
          dispatched++;
          if (failure === "timeout") throw new DaytonaProcessExecutionTimeoutError("timed out");
          throw new Error("fake-vault-password");
        }
        return original(command, cwd, env, timeout);
      });
      const result = provider.pageBrowser(
        computer,
        { command: "snapshot" },
        { ...context, signal: controller.signal },
      );
      await expect(result).rejects.toThrow(
        failure === "upload"
          ? "Could not transfer browser input"
          : failure === "timeout"
            ? "Page browser timed out"
            : failure === "cancel"
              ? /abort/i
              : "Page browser unavailable or interrupted",
      );
      expect(dispatched).toBe(failure === "execute" || failure === "timeout" ? 1 : 0);
      expect(fixture.executeCommand.mock.calls.at(-1)).toEqual([
        expect.stringContaining(`rm -f -- '${inputFile}'`),
        undefined,
        undefined,
        10,
      ]);
    },
  );

  it("waits for an already dispatched action before returning cancellation", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    const original = fixture.executeCommand.getMockImplementation()!;
    const dispatched = deferred();
    const finished = deferred<{ exitCode: number; result: string }>();
    const controller = new AbortController();
    let calls = 0;
    fixture.executeCommand.mockImplementation(async (command, cwd, env, timeout) => {
      if (command.includes("/usr/local/bin/rakazo-page-browser snapshot")) {
        calls++;
        dispatched.resolve();
        return finished.promise;
      }
      return original(command, cwd, env, timeout);
    });
    const result = provider.pageBrowser(
      computer,
      { command: "snapshot" },
      { ...context, signal: controller.signal },
    );
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await dispatched.promise;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    finished.resolve({ exitCode: 0, result: '{"ok":true}' });
    await expect(result).rejects.toThrow(/abort/i);
    expect(calls).toBe(1);
    expect(fixture.executeCommand.mock.calls.at(-1)?.[0]).toMatch(/^rm -f -- /);
  });

  it("forwards an optional snapshot name to create()", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({ snapshot: "rakazo-computer" }, fixture.client);
    await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({ snapshot: "rakazo-computer" }),
      { timeout: 120 },
    );
  });

  it("falls back to DAYTONA_SNAPSHOT when config.snapshot is unset", async () => {
    vi.stubEnv("DAYTONA_SNAPSHOT", " env-snapshot ");
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({ snapshot: "env-snapshot" }),
      { timeout: 120 },
    );
  });

  it("prefers config.snapshot over DAYTONA_SNAPSHOT", async () => {
    vi.stubEnv("DAYTONA_SNAPSHOT", "env-snapshot");
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({ snapshot: " config-snapshot " }, fixture.client);
    await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({ snapshot: "config-snapshot" }),
      { timeout: 120 },
    );
  });

  it("prunes excluded directories before listing their contents and keeps project core", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    for (const file of [
      "project/node_modules/pkg/index.js",
      ".cache/uv/data",
      ".yarn/cache/pkg",
      ".yarn/patches/fix.patch",
      "packages/core/notes.txt",
      "core.123",
      "run.log",
      ".browser-profiles/chromium/Cache/data",
      ".browser-profiles/chromium/Default/Cookies",
    ]) {
      await provider.writeFile(computer, { path: file, content: Buffer.from("ok") }, context);
    }
    const listing = vi.spyOn(fixture.sandbox.fs, "listFiles");
    const files = [];
    for await (const file of provider.exportWorkspace(computer, context)) files.push(file.path);
    expect(files.sort()).toEqual([
      ".browser-profiles/chromium/Default/Cookies",
      ".yarn/patches/fix.patch",
      "packages/core/notes.txt",
    ]);
    const visited = listing.mock.calls.map(([directory]) => directory);
    expect(visited).not.toContain("/home/daytona/rakazo-home/project/node_modules");
    expect(visited).not.toContain("/home/daytona/rakazo-home/.cache");
    expect(visited).not.toContain("/home/daytona/rakazo-home/.yarn/cache");
    expect(visited).not.toContain("/home/daytona/rakazo-home/.browser-profiles/chromium/Cache");
  });

  it("refuses an over-limit home before downloading any of its files", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await provider.writeFile(computer, { path: "notes.txt", content: Buffer.from("ok") }, context);
    await provider.writeFile(computer, { path: "model.bin", content: Buffer.alloc(10) }, context);
    await provider.writeFile(
      computer,
      { path: ".cache/uv/data", content: Buffer.alloc(100) },
      context,
    );
    const download = vi.spyOn(fixture.sandbox.fs, "downloadFile");
    const exportWith = async (limits: { maxBytes: number; maxFiles: number }) => {
      const files = [];
      for await (const file of provider.exportWorkspace(computer, context, limits)) {
        files.push(file.path);
      }
      return files;
    };

    await expect(exportWith({ maxBytes: 4, maxFiles: 10 })).rejects.toEqual(
      new WorkspaceTooLargeError("bytes"),
    );
    await expect(exportWith({ maxBytes: 100, maxFiles: 1 })).rejects.toEqual(
      new WorkspaceTooLargeError("files"),
    );
    expect(download).not.toHaveBeenCalled();
    // Exactly at both limits is allowed; the skipped cache does not count.
    expect((await exportWith({ maxBytes: 12, maxFiles: 2 })).sort()).toEqual([
      "model.bin",
      "notes.txt",
    ]);
  });

  it("counts files in every folder before downloading a folder past the limit", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await provider.writeFile(computer, { path: "notes.txt", content: Buffer.from("ok") }, context);
    await provider.writeFile(
      computer,
      { path: "models/model.bin", content: Buffer.alloc(10) },
      context,
    );
    const download = vi.spyOn(fixture.sandbox.fs, "downloadFile");
    const limits = { maxBytes: 4, maxFiles: 10 };
    const exporting = async () => {
      const files = [];
      for await (const file of provider.exportWorkspace(computer, context, limits)) {
        files.push(file.path);
      }
      return files;
    };

    await expect(exporting()).rejects.toEqual(new WorkspaceTooLargeError("bytes"));
    expect(download.mock.calls.map(([target]) => target.split("/").at(-1))).toEqual(["notes.txt"]);
  });

  it("omits snapshot from create() when unset", async () => {
    vi.stubEnv("DAYTONA_SNAPSHOT", "   ");
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    expect(fixture.create.mock.calls[0]?.[0]).not.toHaveProperty("snapshot");
  });

  it("preserves desktop command output in failures", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await provider.prepare(computer, context);
    fixture.executeCommand.mockResolvedValueOnce({ exitCode: 1, result: "could not start Xvfb" });

    await expect(provider.observe(computer, context)).rejects.toThrow("could not start Xvfb");
  });

  it("implements the portable command, file, screen, and computer-use contract", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await provider.prepare(computer, context);

    expect(computer).toMatchObject({
      id: "daytona-box",
      kind: "daytona",
      providerRef: "daytona-box",
      fresh: true,
    });
    expect(computer).not.toHaveProperty("started");
    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringMatching(/^rakazo-/),
        labels: { botId: "bot-a", rakazo: "computer" },
        envVars: { VNC_RESOLUTION: "1280x800" },
      }),
      { timeout: 120 },
    );

    const events = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["echo", "hello"], env: { FAKE_TOKEN: "fake-secret" }, unsetEnv: ["FAILED"] },
      context,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "stdout", data: "hello\n" },
      { type: "exit", code: 0 },
    ]);
    // Secrets go in the env field, never in command text.
    expect(fixture.executeCommand).toHaveBeenCalledWith(
      "'env' '-u' 'FAILED' '--' 'echo' 'hello'",
      "/home/daytona/rakazo-home",
      { FAKE_TOKEN: "fake-secret" },
      300,
    );

    const binary = Uint8Array.from([0, 255, 1, 128]);
    await provider.writeFile(
      computer,
      { path: "bin/tool", content: binary, executable: true },
      context,
    );
    expect(await provider.readFile(computer, "bin/tool", context)).toEqual(binary);
    await assertSandboxReadLimit(provider, computer, context, {
      path: "bin/tool",
      content: binary,
    });
    expect(await provider.listFiles(computer, "bin", context)).toEqual([
      { path: "bin/tool", kind: "file", size: 4, executable: true },
    ]);
    const exported = [];
    for await (const file of provider.exportWorkspace(computer, context)) exported.push(file);
    expect(exported).toContainEqual({
      path: "bin/tool",
      content: binary,
      executable: true,
    });

    const observation = await provider.observe(computer, context);
    expect(observation).toMatchObject({
      mimeType: "image/png",
      width: 1280,
      height: 800,
      cursor: { x: 10, y: 20 },
    });
    expect(observation.image).toEqual(Uint8Array.from([1, 2, 3]));

    const result = await provider.act(
      computer,
      {
        actions: [
          { kind: "pointer", type: "down", x: 10, y: 20 },
          { kind: "pointer", type: "up", x: 30, y: 40 },
          { kind: "key", key: "enter" },
          { kind: "clipboard", text: "hello" },
          { kind: "scroll", direction: "down", amount: 2 },
        ],
        observe: false,
      },
      context,
    );
    expect(result).toEqual({ completed: 5 });
    expect(fixture.executeCommand).toHaveBeenCalledWith(
      expect.stringContaining("mousemove 10 20 mousedown 1"),
      undefined,
      undefined,
      300,
    );
    expect(fixture.executeCommand).toHaveBeenCalledWith(
      expect.stringContaining("mousemove 30 40 mouseup 1"),
      undefined,
      undefined,
      300,
    );
    const [screen, interactiveScreen] = await Promise.all([
      provider.connectScreen(computer, { view: "stream", interactive: false }, context),
      provider.connectScreen(
        computer,
        { view: "stream", interactive: true, controlToken: "control-1" },
        context,
      ),
    ]);
    expect(screen.url).toContain("/vnc.html");
    expect(new URL(screen.url!).searchParams.get("path")).toMatch(/^websockify\?token=view-/);
    await screen.close();
    expect(new URL(interactiveScreen.url!).searchParams.get("path")).toBe(
      "websockify?token=control-1",
    );
    expect(fixture.getSignedPreviewUrl).toHaveBeenCalledOnce();

    await provider.stop(computer, context);
    expect(fixture.expireSignedPreviewUrl).toHaveBeenCalledWith(6100, "preview-token");
    expect(fixture.stop).toHaveBeenCalledWith(120);
  });

  it("reconnects stopped sandboxes and replaces missing ones", async () => {
    const existing = daytonaFixture({ id: "existing", state: "stopped" });
    const provider = new DaytonaSandboxProvider({}, existing.client);
    const reconnected = await provider.provision(
      {
        botId: "bot-a",
        homePath: "/unused",
        providerRef: "existing",
        providerKind: "daytona",
      },
      context,
    );
    expect(existing.start).toHaveBeenCalledWith(120);
    expect(reconnected).toMatchObject({
      providerRef: "existing",
      fresh: false,
      started: true,
    });

    const replacement = daytonaFixture({ id: "replacement" });
    const replacingProvider = new DaytonaSandboxProvider({}, replacement.client);
    const replaced = await replacingProvider.provision(
      {
        botId: "bot-b",
        homePath: "/unused",
        providerRef: "missing",
        providerKind: "daytona",
      },
      context,
    );
    expect(replaced).toMatchObject({ providerRef: "replacement", fresh: true });
  });

  describe("reconnecting from each Daytona state", () => {
    const request = {
      botId: "bot-a",
      homePath: "/unused",
      providerRef: "existing",
      providerKind: "daytona" as const,
    };

    type Case = {
      state: SandboxState;
      desiredState?: DaytonaSandbox["desiredState"];
      recoverable?: boolean;
      /** States Daytona reports on later refreshes, as a background transition progresses. */
      later?: SandboxState[];
      expected: "running" | "started" | "replaced";
      call?: "start" | "recover" | "waitUntilStarted";
      timeout?: number;
    };
    const cases: Case[] = [
      { state: "started", expected: "running" },
      { state: "stopped", desiredState: "stopped", expected: "started", call: "start" },
      { state: "paused", desiredState: "paused", expected: "started", call: "start" },
      {
        state: "archived",
        desiredState: "archived",
        expected: "started",
        call: "start",
        timeout: 600,
      },
      { state: "starting", expected: "started", call: "waitUntilStarted" },
      { state: "restoring", expected: "started", call: "waitUntilStarted", timeout: 600 },
      { state: "creating", expected: "started", call: "waitUntilStarted" },
      { state: "pulling_snapshot", expected: "started", call: "waitUntilStarted" },
      { state: "resuming", expected: "started", call: "waitUntilStarted" },
      {
        state: "stopping",
        desiredState: "stopped",
        later: ["stopping", "stopped"],
        expected: "started",
        call: "start",
        // Two one-second polls of the 120 second budget have passed.
        timeout: 118,
      },
      {
        state: "archiving",
        desiredState: "archived",
        later: ["archived"],
        expected: "started",
        call: "start",
        // One poll of the restore budget has passed.
        timeout: 599,
      },
      { state: "unknown", later: ["started"], expected: "started" },
      { state: "error", recoverable: true, expected: "started", call: "recover" },
      { state: "error", recoverable: false, expected: "replaced" },
      { state: "build_failed", expected: "replaced" },
      { state: "destroying", desiredState: "destroyed", expected: "replaced" },
      { state: "destroyed", desiredState: "destroyed", expected: "replaced" },
    ];

    it.each(cases)("$state (recoverable: $recoverable) -> $expected", async (testCase) => {
      vi.useFakeTimers();
      const fixture = daytonaFixture({
        id: "existing",
        createdId: "replacement",
        state: testCase.state,
        desiredState: testCase.desiredState ?? "started",
        recoverable: testCase.recoverable,
        later: testCase.later,
      });
      const provider = new DaytonaSandboxProvider({}, fixture.client);

      const computer = await drive(provider.provision(request, context));

      if (testCase.expected === "replaced") {
        expect(computer).toMatchObject({ providerRef: "replacement", fresh: true });
        expect(fixture.start).not.toHaveBeenCalled();
        return;
      }
      expect(computer).toMatchObject({ providerRef: "existing", fresh: false });
      expect(computer.started).toBe(testCase.expected === "started" ? true : undefined);
      expect(fixture.create).not.toHaveBeenCalled();
      if (testCase.call) {
        expect(fixture[testCase.call]).toHaveBeenCalledWith(testCase.timeout ?? 120);
      }
    });

    type ErrorCase = {
      name: string;
      state?: SandboxState;
      arrange: (fixture: DaytonaFixture) => void;
      expected: "started" | "replaced" | Error;
    };
    const rateLimited = new DaytonaRateLimitError("Too many requests", 429);
    const unauthorized = new DaytonaAuthenticationError("Invalid API key", 401);
    const regionMissing = new DaytonaNotFoundError("Region not found", 404);
    const errorCases: ErrorCase[] = [
      {
        name: "409 while another state change is in progress waits for it",
        arrange: (fixture) =>
          fixture.start.mockImplementationOnce(async () => {
            fixture.remote.state = "starting";
            fixture.remote.desiredState = "started";
            throw new DaytonaConflictError("Sandbox state change in progress", 409);
          }),
        expected: "started",
      },
      {
        name: "410 from start is gone",
        arrange: (fixture) =>
          fixture.start.mockRejectedValueOnce(new DaytonaGoneError("Sandbox is gone", 410)),
        expected: "replaced",
      },
      {
        name: "410 from get is gone",
        arrange: (fixture) =>
          fixture.get.mockRejectedValueOnce(new DaytonaGoneError("Sandbox is gone", 410)),
        expected: "replaced",
      },
      {
        name: "400 because the sandbox errored after lookup is gone when unrecoverable",
        arrange: (fixture) => {
          fixture.remote.state = "error";
          fixture.remote.recoverable = false;
          fixture.get.mockImplementationOnce(async () => {
            fixture.sandbox.state = "stopped";
            return fixture.sandbox;
          });
        },
        expected: "replaced",
      },
      {
        name: "a start that ends in an unrecoverable error is gone",
        arrange: (fixture) =>
          fixture.start.mockImplementationOnce(async () => {
            fixture.remote.state = "error";
            fixture.remote.recoverable = false;
            throw new DaytonaError("Sandbox existing failed to start with status: error");
          }),
        expected: "replaced",
      },
      {
        name: "a recovery that fails again is gone",
        state: "error",
        arrange: (fixture) => {
          fixture.remote.recoverable = true;
          fixture.recover.mockRejectedValueOnce(
            new DaytonaError("Sandbox existing failed to start with status: error"),
          );
        },
        expected: "replaced",
      },
      {
        name: "404 for something other than the sandbox is not gone",
        arrange: (fixture) => fixture.start.mockRejectedValueOnce(regionMissing),
        expected: regionMissing,
      },
      {
        name: "401 is surfaced",
        arrange: (fixture) => fixture.get.mockRejectedValueOnce(unauthorized),
        expected: unauthorized,
      },
      {
        name: "429 is a computer rate limit",
        arrange: (fixture) => fixture.start.mockRejectedValueOnce(rateLimited),
        expected: new SandboxRateLimitError(),
      },
      {
        name: "a transition that never settles times out instead of hanging",
        state: "stopping",
        arrange: () => undefined,
        expected: new DaytonaTimeoutError("Daytona sandbox existing is still stopping"),
      },
      {
        name: "an archived sandbox that keeps conflicting times out instead of hanging",
        state: "archived",
        arrange: (fixture) =>
          fixture.start.mockRejectedValue(
            new DaytonaConflictError("Sandbox state change in progress", 409),
          ),
        expected: new DaytonaTimeoutError("Daytona sandbox existing is still archived"),
      },
    ];

    it.each(errorCases)("$name", async ({ state, arrange, expected }) => {
      vi.useFakeTimers();
      const fixture = daytonaFixture({
        id: "existing",
        createdId: "replacement",
        state: state ?? "stopped",
        desiredState: "stopped",
      });
      arrange(fixture);
      const provider = new DaytonaSandboxProvider({}, fixture.client);
      const provisioning = drive(provider.provision(request, context));

      if (expected instanceof Error) {
        await expect(provisioning).rejects.toThrow(expected.message);
        await provisioning.catch((error: unknown) => expect(isSandboxGoneError(error)).toBe(false));
        expect(fixture.create).not.toHaveBeenCalled();
        expect(fixture.deleteSandbox).not.toHaveBeenCalled();
        return;
      }
      const computer = await provisioning;
      expect(computer).toMatchObject(
        expected === "replaced"
          ? { providerRef: "replacement", fresh: true }
          : { providerRef: "existing", fresh: false, started: true },
      );
    });
  });

  describe("stopping from each Daytona state", () => {
    const computer = {
      id: "existing",
      botId: "bot-a",
      kind: "daytona" as const,
      providerRef: "existing",
      fresh: false,
    };

    type Case = {
      state: SandboxState;
      later?: SandboxState[];
      stops: boolean;
    };
    const cases: Case[] = [
      { state: "started", stops: true },
      { state: "paused", stops: true },
      { state: "stopped", stops: false },
      { state: "archived", stops: false },
      { state: "archiving", stops: false },
      { state: "error", stops: false },
      { state: "build_failed", stops: false },
      { state: "destroying", stops: false },
      { state: "destroyed", stops: false },
      { state: "stopping", later: ["stopping", "stopped"], stops: false },
      { state: "starting", later: ["started"], stops: true },
      { state: "unknown", later: ["started"], stops: true },
    ];

    it.each(cases)("$state", async ({ state, later, stops }) => {
      vi.useFakeTimers();
      const fixture = daytonaFixture({ id: "existing", state, later });
      const provider = new DaytonaSandboxProvider({}, fixture.client);

      await expect(drive(provider.stop(computer, context))).resolves.toBeUndefined();
      expect(fixture.stop).toHaveBeenCalledTimes(stops ? 1 : 0);
      if (stops) expect(fixture.remote.state).toBe("stopped");
    });

    type ErrorCase = {
      name: string;
      state?: SandboxState;
      later?: SandboxState[];
      arrange: (fixture: DaytonaFixture) => void;
      expected?: Error;
    };
    const rateLimited = new DaytonaRateLimitError("Too many requests", 429);
    const errorCases: ErrorCase[] = [
      {
        name: "409 while another state change is in progress waits for it",
        later: ["stopped"],
        arrange: (fixture) =>
          fixture.stop.mockImplementationOnce(async () => {
            fixture.remote.state = "stopping";
            throw new DaytonaConflictError("Sandbox state change in progress", 409);
          }),
      },
      {
        name: "410 from stop is already gone",
        arrange: (fixture) =>
          fixture.stop.mockRejectedValueOnce(new DaytonaGoneError("Sandbox is gone", 410)),
      },
      {
        name: "404 from stop after the sandbox was deleted is already gone",
        arrange: (fixture) =>
          fixture.stop.mockImplementationOnce(async () => {
            fixture.remote.missing = true;
            throw new DaytonaNotFoundError("Sandbox not found", 404);
          }),
      },
      {
        name: "400 because the sandbox stopped after lookup is already stopped",
        arrange: (fixture) => {
          fixture.remote.state = "stopped";
          fixture.get.mockImplementationOnce(async () => {
            fixture.sandbox.state = "started";
            return fixture.sandbox;
          });
        },
      },
      {
        name: "a stop that ends in an error has nothing left to stop",
        arrange: (fixture) =>
          fixture.stop.mockImplementationOnce(async () => {
            fixture.remote.state = "error";
            throw new DaytonaError("Sandbox failed to stop with status: error");
          }),
      },
      {
        name: "429 is a computer rate limit",
        arrange: (fixture) => fixture.stop.mockRejectedValueOnce(rateLimited),
        expected: new SandboxRateLimitError(),
      },
      {
        name: "a stop that never settles times out instead of hanging",
        state: "stopping",
        arrange: () => undefined,
        expected: new DaytonaTimeoutError("Daytona sandbox existing is still stopping"),
      },
    ];

    it.each(errorCases)("$name", async ({ state, later, arrange, expected }) => {
      vi.useFakeTimers();
      const fixture = daytonaFixture({ id: "existing", state: state ?? "started", later });
      arrange(fixture);
      const provider = new DaytonaSandboxProvider({}, fixture.client);
      const stopping = drive(provider.stop(computer, context));

      if (expected) await expect(stopping).rejects.toThrow(expected.message);
      else await expect(stopping).resolves.toBeUndefined();
    });
  });

  it("deletes the sandbox a timed-out create left behind", async () => {
    const fixture = daytonaFixture();
    const timeout = new DaytonaTimeoutError(
      "Failed to create and start sandbox within 120 seconds",
    );
    fixture.create.mockImplementationOnce(async (params) => {
      fixture.remote.name = params.name;
      fixture.remote.missing = false;
      fixture.remote.state = "creating";
      throw timeout;
    });
    const provider = new DaytonaSandboxProvider({}, fixture.client);

    await expect(provider.provision({ botId: "bot-a", homePath: "/unused" }, context)).rejects.toBe(
      timeout,
    );
    const name = fixture.create.mock.calls[0]?.[0].name;
    expect(name).toMatch(/^rakazo-/);
    expect(fixture.get).toHaveBeenCalledWith(name);
    expect(fixture.deleteSandbox).toHaveBeenCalledOnce();
    expect(fixture.remote.missing).toBe(true);
  });

  describe("a sandbox a timed-out create left behind", () => {
    const timeout = new DaytonaTimeoutError(
      "Failed to create and start sandbox within 120 seconds",
    );
    async function start(fixture: ReturnType<typeof daytonaFixture>, records?: MachineRecords) {
      fixture.create.mockImplementationOnce(async (params) => {
        fixture.remote.name = params.name;
        fixture.remote.missing = false;
        fixture.remote.state = "creating";
        throw timeout;
      });
      const provider = new DaytonaSandboxProvider(
        { unreferencedMachines: records },
        fixture.client,
      );
      const outcome = await settleMachineCleanup(() =>
        provider.provision({ botId: "bot-a", homePath: "/unused" }, context),
      );
      return { ...outcome, name: fixture.create.mock.calls[0]?.[0].name };
    }

    it("is deleted when the first delete fails", async () => {
      const fixture = daytonaFixture();
      fixture.deleteSandbox.mockRejectedValueOnce(new Error("connection reset"));

      const { error, left } = await start(fixture);

      expect(error).toBe(timeout);
      expect(fixture.deleteSandbox).toHaveBeenCalledTimes(2);
      expect(fixture.remote.missing).toBe(true);
      expect(left).toEqual([]);
    });

    it("is reported by name when it cannot be deleted, and the timeout stands", async () => {
      const fixture = daytonaFixture();
      fixture.deleteSandbox.mockRejectedValue(new Error("connection reset"));

      const { error, left, name } = await start(fixture);

      expect(error).toBe(timeout);
      expect(fixture.deleteSandbox).toHaveBeenCalledTimes(4);
      // Seconds: what its try has left of the cleanup's time, never a minute of its own.
      expect(fixture.deleteSandbox).toHaveBeenNthCalledWith(1, 10);
      expect(left).toEqual([{ provider: "daytona", machineId: name }]);
    });

    it("is handed to the records by name when it cannot be deleted", async () => {
      const fixture = daytonaFixture();
      fixture.deleteSandbox.mockRejectedValue(new Error("connection reset"));
      const records = new MachineRecords();

      const { name } = await start(fixture, records);

      expect([...records.due.values()].map((entry) => entry.machine)).toEqual([
        { provider: "daytona", machineId: name, homeKey: "bot-a" },
      ]);
    });
  });

  it("records a new sandbox for its computer, under the id that computer will store", async () => {
    const fixture = daytonaFixture({ createdId: "daytona-new" });
    const records = new MachineRecords();
    const provider = new DaytonaSandboxProvider({ unreferencedMachines: records }, fixture.client);

    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);

    expect(computer.providerRef).toBe("daytona-new");
    expect(records.dueIn()).toMatchObject([
      { provider: "daytona", machineId: "daytona-new", homeKey: "bot-a" },
    ]);
    expect(records.dueIn()[0]?.dueInMs).toBeGreaterThan(15 * 60_000);
  });

  it("deletes a sandbox from its id or name alone, and counts one already gone as deleted", async () => {
    const fixture = daytonaFixture({ state: "started" });
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const signal = AbortSignal.timeout(5_000);
    const byId = { provider: "daytona", machineId: fixture.remote.id };

    await provider.deleteMachine(byId, signal);

    expect(fixture.remote.missing).toBe(true);
    await expect(provider.deleteMachine(byId, signal)).resolves.toBeUndefined();

    Object.assign(fixture.remote, { missing: false, name: "rakazo-created-under" });
    await provider.deleteMachine(
      { provider: "daytona", machineId: "rakazo-created-under" },
      signal,
    );

    expect(fixture.remote.missing).toBe(true);
  });

  describe("Daytona rate limits", () => {
    /** Daytona's error headers are axios headers; a plain record stands in for them here. */
    const retryAfter = (value: string) =>
      ({ "retry-after": value }) as unknown as DaytonaError["headers"];
    const computer = {
      id: "existing",
      botId: "bot-a",
      kind: "daytona" as const,
      providerRef: "existing",
      fresh: false,
    };

    function expectRateLimit(error: unknown, cause: DaytonaRateLimitError) {
      expect(error).toBeInstanceOf(SandboxRateLimitError);
      expect((error as SandboxRateLimitError).cause).toBe(cause);
      expect((error as SandboxRateLimitError).retryAfterMs).toBe(30_000);
    }

    it("reports a refused create as a rate limit and skips deleting the sandbox", async () => {
      const fixture = daytonaFixture();
      const rejected = new DaytonaRateLimitError("Too many requests", 429, retryAfter("30"));
      fixture.create.mockRejectedValueOnce(rejected);
      const provider = new DaytonaSandboxProvider({}, fixture.client);

      const error = await provider
        .provision({ botId: "bot-a", homePath: "/unused" }, context)
        .catch((failure: unknown) => failure);

      expectRateLimit(error, rejected);
      expect(fixture.deleteSandbox).not.toHaveBeenCalled();
    });

    const existing = {
      botId: "bot-a",
      homePath: "/unused",
      providerRef: "existing",
      providerKind: "daytona" as const,
    };
    const cases: {
      name: string;
      state: SandboxState;
      arrange: (fixture: DaytonaFixture, cause: DaytonaRateLimitError) => void;
      call: (provider: DaytonaSandboxProvider) => Promise<unknown>;
    }[] = [
      {
        name: "reading an existing sandbox while provisioning",
        state: "started",
        arrange: (fixture, cause) => fixture.get.mockRejectedValueOnce(cause),
        call: (provider) => provider.provision(existing, context),
      },
      {
        name: "starting an existing sandbox while provisioning",
        state: "stopped",
        arrange: (fixture, cause) => fixture.start.mockRejectedValueOnce(cause),
        call: (provider) => provider.provision(existing, context),
      },
      {
        name: "reading a sandbox to check it is running",
        state: "started",
        arrange: (fixture, cause) => fixture.get.mockRejectedValueOnce(cause),
        call: (provider) => provider.isRunning(computer, context),
      },
      {
        name: "stopping a sandbox",
        state: "started",
        arrange: (fixture, cause) => fixture.stop.mockRejectedValueOnce(cause),
        call: (provider) => provider.stop(computer, context),
      },
      {
        name: "deleting a sandbox on destroy",
        state: "started",
        arrange: (fixture, cause) => fixture.deleteSandbox.mockRejectedValueOnce(cause),
        call: (provider) => provider.destroy(computer, context),
      },
      {
        name: "deleting a sandbox in background cleanup",
        state: "started",
        arrange: (fixture, cause) => fixture.get.mockRejectedValueOnce(cause),
        call: (provider) =>
          provider.deleteMachine(
            { provider: "daytona", machineId: "existing" },
            AbortSignal.timeout(5_000),
          ),
      },
    ];

    it.each(cases)("reports a Daytona 429 from $name as a rate limit", async (testCase) => {
      const fixture = daytonaFixture({ id: "existing", state: testCase.state });
      const cause = new DaytonaRateLimitError("Too many requests", 429, retryAfter("30"));
      testCase.arrange(fixture, cause);
      const provider = new DaytonaSandboxProvider({}, fixture.client);

      const error = await testCase.call(provider).catch((failure: unknown) => failure);

      expectRateLimit(error, cause);
    });
  });

  it("drops a cached handle once Daytona reports the sandbox gone", async () => {
    vi.useFakeTimers();
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await provider.prepare(computer, context);
    fixture.remote.missing = true;

    // A recently checked handle is trusted without asking Daytona.
    await expect(provider.readFile(computer, "missing.txt", context)).resolves.toEqual(
      new Uint8Array(),
    );
    expect(fixture.get).not.toHaveBeenCalled();

    vi.advanceTimersByTime(61_000);
    const failure = await provider.prepare(computer, context).catch((error: unknown) => error);
    expect(isSandboxGoneError(failure)).toBe(true);

    // Reconnecting replaces the sandbox instead of reusing the dead handle.
    fixture.options.createdId = "replacement";
    const replaced = await provider.provision(
      { botId: "bot-a", homePath: "/unused", providerRef: "daytona-box", providerKind: "daytona" },
      context,
    );
    expect(replaced).toMatchObject({ providerRef: "replacement", fresh: true });
  });

  it("re-validates a cached handle when the computer is provisioned again", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await provider.prepare(computer, context);
    // Stopped outside Rakazo, for example from the Daytona dashboard.
    fixture.remote.state = "stopped";
    fixture.remote.desiredState = "stopped";

    const reconnected = await provider.provision(
      { botId: "bot-a", homePath: "/unused", providerRef: "daytona-box", providerKind: "daytona" },
      context,
    );
    expect(reconnected).toMatchObject({ providerRef: "daytona-box", fresh: false, started: true });
    expect(fixture.start).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent reconnect and workspace preparation", async () => {
    const fixture = daytonaFixture({ id: "shared", state: "stopped" });
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const request = {
      botId: "bot-a",
      homePath: "/unused",
      providerRef: "shared",
      providerKind: "daytona" as const,
    };

    const computers = await Promise.all([
      provider.provision(request, context),
      provider.provision(request, context),
    ]);
    await Promise.all(computers.map((computer) => provider.prepare(computer, context)));

    expect(fixture.get).toHaveBeenCalledTimes(1);
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(
      fixture.executeCommand.mock.calls.filter(([command]) =>
        String(command).startsWith("mkdir -p -- "),
      ),
    ).toHaveLength(1);
  });

  it("returns a fresh reference before workspace preparation fails", async () => {
    const fixture = daytonaFixture({ prepareFails: true });
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);

    expect(computer).toMatchObject({ providerRef: "daytona-box", fresh: true });
    await expect(provider.prepare(computer, context)).rejects.toThrow(
      /could not create Daytona workspace/,
    );
    expect(fixture.deleteSandbox).not.toHaveBeenCalled();
  });

  it("surfaces transient stop failures so cleanup can retry", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await provider.prepare(computer, context);
    fixture.stop.mockRejectedValueOnce(new Error("temporary Daytona outage"));

    await expect(provider.stop(computer, context)).rejects.toThrow("temporary Daytona outage");
    await expect(provider.stop(computer, context)).resolves.toBeUndefined();
    expect(fixture.get).toHaveBeenCalledTimes(1);
    expect(fixture.stop).toHaveBeenCalledTimes(2);
  });

  it("reports only a started sandbox as running, without starting it", async () => {
    const fixture = daytonaFixture({ id: "remote", state: "stopped" });
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = {
      id: "remote",
      botId: "bot-a",
      kind: "daytona" as const,
      providerRef: "remote",
    };

    expect(await provider.isRunning(computer, context)).toBe(false);
    fixture.remote.state = "started";
    expect(await provider.isRunning(computer, context)).toBe(true);
    expect(await provider.isRunning({ ...computer, kind: "e2b" }, context)).toBe(false);
    fixture.remote.missing = true;
    expect(await provider.isRunning(computer, context)).toBe(false);
    fixture.get.mockRejectedValueOnce(new Error("temporary Daytona outage"));
    await expect(provider.isRunning(computer, context)).rejects.toThrow("temporary Daytona outage");
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("distinguishes transient lookup failures from an already deleted sandbox", async () => {
    const fixture = daytonaFixture({ id: "remote" });
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = {
      id: "remote",
      botId: "bot-a",
      kind: "daytona" as const,
      providerRef: "remote",
      fresh: false,
    };
    fixture.get.mockRejectedValueOnce(new Error("temporary Daytona outage"));

    await expect(provider.stop(computer, context)).rejects.toThrow("temporary Daytona outage");
    await expect(provider.stop(computer, context)).resolves.toBeUndefined();
  });

  it("accepts definitive deletion while preserving transient teardown failures", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    const failure = new Error("temporary Daytona outage");
    fixture.deleteSandbox
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(new DaytonaNotFoundError("Sandbox not found", 404));

    await expect(provider.destroy(computer, context)).rejects.toBe(failure);
    await expect(provider.destroy(computer, context)).resolves.toBeUndefined();
    expect(fixture.deleteSandbox).toHaveBeenCalledTimes(2);
    // Subsequent teardown can also observe the missing resource during lookup.
    fixture.remote.missing = true;
    await expect(provider.destroy(computer, context)).resolves.toBeUndefined();
    expect(fixture.deleteSandbox).toHaveBeenCalledTimes(2);
  });

  it("gives Team bots distinct Daytona previews using the shared runtime", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "team-home", homePath: "/unused" }, context);
    await provider.prepare(computer, context);
    const writer = { ...context, botId: "writer" };
    const researcher = { ...context, botId: "researcher" };

    fixture.getSignedPreviewUrl.mockImplementation(async (port: number) => ({
      sandboxId: "daytona-box",
      port,
      url: `https://${port}-preview.proxy.daytona.test`,
      token: `token-${port}`,
    }));
    await provider.observe(computer, writer);
    await provider.observe(computer, researcher);
    const writerView = await provider.connectScreen(
      computer,
      { view: "stream", interactive: false },
      writer,
    );
    const researcherView = await provider.connectScreen(
      computer,
      { view: "stream", interactive: false },
      researcher,
    );
    expect(writerView.url).toContain("6100-preview");
    expect(
      fixture.executeCommand.mock.calls.some(([command]) => command.includes("0.0.0.0:6100 8>&-")),
    ).toBe(true);
    expect(researcherView.url).not.toBe(writerView.url);
    expect(researcherView.url).toContain("6100-preview");
    expect(new URL(researcherView.url!).searchParams.get("path")).toMatch(
      /^websockify\?token=view-/,
    );

    await provider.act(
      computer,
      {
        actions: [{ kind: "pointer", type: "click", x: 4, y: 5 }],
        observe: false,
      },
      researcher,
    );
    expect(
      fixture.executeCommand.mock.calls.some(([command]) => command.includes("DISPLAY=:21")),
    ).toBe(true);

    await provider.releaseScreen(computer, writer);
    await expect(provider.observe(computer, researcher)).resolves.toMatchObject({
      width: 1280,
      height: 800,
    });

    const researcherControl = await provider.connectScreen(
      computer,
      { view: "stream", interactive: true, controlToken: "lease-1" },
      researcher,
    );
    expect(researcherControl.url).toContain("6100-preview");
    expect(new URL(researcherControl.url!).searchParams.get("path")).toBe(
      "websockify?token=lease-1",
    );
    expect(
      fixture.executeCommand.mock.calls.some(([command]) =>
        String(command).includes("sockets/control-"),
      ),
    ).toBe(true);

    expect(provider.describe().capabilities.multiScreen).toBe(true);
  });
});

/** Runs fake timers until the promise settles, so state polling completes without waiting. */
async function drive<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let elapsed = 0; !settled && elapsed < 1_000_000; elapsed += 1_000) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
  return promise;
}

type DaytonaFixture = ReturnType<typeof daytonaFixture>;

/**
 * A stateful fake of the Daytona SDK surface the adapter uses. `remote` is what the Daytona API
 * knows; the sandbox handle only sees it through get(), refreshData() and lifecycle calls.
 */
