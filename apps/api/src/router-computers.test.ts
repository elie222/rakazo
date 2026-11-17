import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { SandboxFileTooLargeError } from "@rakazo/adapter-kit";
import * as adapters from "@rakazo/adapters";
import {
  COMPUTER_SCREEN_UNAVAILABLE,
  ComputerBusyError,
  ComputerScreenUnavailableError,
  LocalAgentHomeStore,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { openScreenCapability } from "@rakazo/core/node/screen-capability";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { appHandler, createRouter, handle } from "./router-test-support.js";
import { handleRpcError } from "./rpc-errors.js";

afterEach(() => {
  delete process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
});

describe("computer screen url", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const computerRow = {
    id: "computer-1",
    screenGeneration: 3,
    kind: "e2b",
    scope: "team",
    state: "running",
    providerRef: "sandbox-ref-1",
    homeKey: "home-1",
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
  };

  const callScreenUrl = async (
    connectScreen: () => Promise<unknown>,
    updateMany = vi.fn().mockResolvedValue({ count: 1 }),
  ) => {
    const endRun = vi.fn().mockResolvedValue(1);
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          screenGeneration: 2,
          thread: { id: "thread-1" },
          computer: computerRow,
        }),
      },
      computer: { updateMany },
      $executeRaw: endRun,
      computerExecutionLease: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      sandbox: { connectScreen },
      jobs: { enqueue: vi.fn().mockResolvedValue(undefined) },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "e2b",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const handler = appHandler(deps);
    const response = await handle(
      handler,
      new Request("http://127.0.0.1/rpc/computer/screenUrl", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId: "bot-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { response, updateMany, endRun };
  };

  it("issues lifecycle-bound capabilities for managed-provider screens too", async () => {
    const { response } = await callScreenUrl(async () => ({
      url: "https://screen.example/vnc.html?token=fake-token",
    }));
    expect(response.status).toBe(200);
    const { json } = await response.json();
    const url = new URL(json.url);
    expect(url.origin).toBe("http://127.0.0.1:5173");
    expect(openScreenCapability(url.pathname, "fake-test-secret")).toMatchObject({
      scope: {
        botId: "bot-1",
        computerId: "computer-1",
        botGeneration: 2,
        computerGeneration: 3,
        controlLeaseId: null,
      },
      target: { hostname: "screen.example", interactive: false },
    });
  });

  it("returns desktop provider screen URLs without sealing them", async () => {
    const { response } = await callScreenUrl(async () => ({
      url: "desktop://screen/computer-1",
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: { url: "desktop://screen/computer-1?view_only=true" },
    });
  });

  it("says a screen signs in once, and names the view beside what it shows", async () => {
    const { response } = await callScreenUrl(async () => ({
      url: "embedded-screen://desktop?code=once",
      singleUseSignIn: { screen: "desktop-1" },
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: {
        url: "embedded-screen://desktop?code=once&view_only=true",
        singleUseSignIn: { screen: "desktop-1:view" },
      },
    });
  });

  it("clears the row instead of 500ing when the provider says the sandbox is gone", async () => {
    const { response, updateMany, endRun } = await callScreenUrl(() =>
      Promise.reject(
        Object.assign(new Error("Sandbox is probably not running anymore"), {
          name: "SandboxNotFoundError",
        }),
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { url: null } });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", providerRef: "sandbox-ref-1" },
      data: { state: "stopped", providerRef: null },
    });
    expect(endRun.mock.calls.map(([, , reason]) => reason)).toEqual(["gone"]);
  });

  it("returns the team screen limit", async () => {
    const { response, updateMany } = await callScreenUrl(() =>
      Promise.reject(new ComputerScreenUnavailableError(4)),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "CONFLICT",
        message: "All 4 Team Computer screens are in use (SANDBOX_TEAM_SCREEN_LIMIT)",
      }),
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("reports a failure that only mentions the screen limit as a fault", async () => {
    const { response, updateMany } = await callScreenUrl(() =>
      Promise.reject(
        new Error("cannot allocate another screen (limit 4): private provider detail"),
      ),
    );
    expect(response.status).toBe(500);
    await expect(response.text()).resolves.not.toContain("private provider detail");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("keeps a transport blip an error and leaves the row alone", async () => {
    const { response, updateMany } = await callScreenUrl(() =>
      Promise.reject(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" })),
    );
    expect(response.status).toBe(500);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("returns a recoverable conflict when the screen is temporarily busy", async () => {
    const { response, updateMany } = await callScreenUrl(() =>
      Promise.reject(new ComputerScreenUnavailableError()),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "CONFLICT",
        message: COMPUTER_SCREEN_UNAVAILABLE,
      }),
    });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("computer terminal and file transfer", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const controlled = {
    controlHolder: "user",
    controlLeaseId: "lease-1",
    // Fixed far future: a lease relative to module load expires before a slow suite reaches it.
    controlLeaseExpiresAt: new Date("2999-01-01T00:00:00Z"),
    controlBotId: "bot-1",
  };

  function setup(
    computer: Record<string, unknown> = {},
    maxUploadSizeBytes?: number,
    home?: LocalAgentHomeStore,
  ) {
    const sandbox = {
      execute: vi.fn(async function* () {
        yield { type: "exit" as const, code: 0 };
      }),
      listFiles: vi.fn().mockResolvedValue([]),
      connectTerminal: vi.fn().mockResolvedValue({
        url: "https://screen.example/vnc.html?path=websockify%3Ftoken%3Dterminal-1",
      }),
      readFile: vi.fn().mockResolvedValue(new TextEncoder().encode("hello")),
      writeFile: vi.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      spaceMember: { count: vi.fn(async () => 1) },
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          screenGeneration: 2,
          thread: { id: "thread-1" },
          computer: {
            id: "computer-1",
            screenGeneration: 3,
            kind: "docker",
            scope: "team",
            state: "running",
            providerRef: "sandbox-ref-1",
            homeKey: "home-1",
            controlHolder: "none",
            controlLeaseId: null,
            controlLeaseExpiresAt: null,
            controlBotId: null,
            ...computer,
          },
        }),
      },
      computer: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn(),
      },
      computerExecutionLease: { findUnique: vi.fn().mockResolvedValue(null) },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
      taughtSkill: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      sandbox,
      home,
      jobs: {
        enqueue: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn().mockResolvedValue(undefined),
      },
      events: {
        append: vi.fn().mockResolvedValue(undefined),
        releaseUserControl: vi.fn().mockResolvedValue(true),
        answerTakeoverRequest: vi.fn().mockResolvedValue(true),
      },
      env: {
        maxUploadSizeBytes,
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "docker",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const handler = appHandler(deps);
    const call = async (procedure: string, json: Record<string, unknown>) => {
      const response = await handle(
        handler,
        new Request(`http://127.0.0.1/rpc/computer/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { botId: "bot-1", ...json } }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      return { status: response.status, body: await response.json() };
    };
    return { sandbox, prisma, deps, call };
  }

  it("prepares an unused bot's folders before listing a running Team Computer", async () => {
    const { sandbox, call } = setup();
    let prepared = false;
    sandbox.execute.mockImplementation(async function* () {
      prepared = true;
      yield { type: "exit" as const, code: 0 };
    });
    sandbox.listFiles.mockImplementation(async () => {
      if (!prepared) throw new Error("workspace folder does not exist");
      return [];
    });

    await expect(call("files", { path: "" })).resolves.toEqual({
      status: 200,
      body: { json: [] },
    });
    expect(sandbox.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sandbox-ref-1" }),
      { argv: ["mkdir", "-p", "shared", "bots/bot-1"] },
      expect.anything(),
    );
    expect(sandbox.listFiles).toHaveBeenCalledWith(
      expect.anything(),
      "bots/bot-1",
      expect.anything(),
    );
  });

  it("tells a second person the computer is busy instead of taking it from the first", async () => {
    const { prisma, call } = setup({ ...controlled, controlUserId: "user-2" });
    await expect(call("takeover", {})).resolves.toMatchObject({
      status: 409,
      body: { json: { message: "Someone else is using this computer" } },
    });
    expect(prisma.computer.updateMany).not.toHaveBeenCalled();
  });

  it("gives control while the bot is working, for as long as the page checks in, and counts the change", async () => {
    const { prisma, call } = setup();
    const before = Date.now();
    await expect(call("takeover", {})).resolves.toMatchObject({ status: 200 });
    const grant = vi.mocked(prisma.computer.updateMany).mock.calls[0]![0];
    expect(grant.data).toMatchObject({
      controlHolder: "user",
      controlBotId: "bot-1",
      controlUserId: "user-1",
      controlFence: { increment: 1 },
    });
    const expiresAt = (grant.data as { controlLeaseExpiresAt: Date }).controlLeaseExpiresAt;
    expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(90_000);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(90_000);
  });

  it("never lets holding the screen answer a request the bot made to someone else", async () => {
    const { prisma, deps, call } = setup({ ...controlled, controlUserId: "user-1" });
    vi.mocked(prisma.run.findFirst).mockResolvedValue({ id: "run-1", userId: "user-2" } as never);
    for (const reason of ["done", "skipped"]) {
      await expect(call("release", { reason, runId: "run-1" })).resolves.toMatchObject({
        status: 409,
        body: { json: { message: "The bot is waiting for someone else" } },
      });
    }
    expect(deps.events.answerTakeoverRequest).not.toHaveBeenCalled();
    // A refused answer leaves this person's control as it was.
    expect(deps.events.releaseUserControl).not.toHaveBeenCalled();
  });

  it("answers Done after the person's lease lapsed, ending that lease and granting nothing", async () => {
    const lapsed = { ...controlled, controlUserId: "user-1", controlLeaseExpiresAt: new Date(0) };
    const { prisma, deps, call } = setup(lapsed);
    vi.mocked(prisma.run.findFirst).mockResolvedValue({ id: "run-1", userId: "user-1" } as never);
    await expect(call("release", { reason: "done", runId: "run-1" })).resolves.toMatchObject({
      status: 200,
    });
    // The lapsed lease is revoked and cleared before the answer lands; nothing is granted.
    const released = vi.mocked(deps.events.releaseUserControl).mock.invocationCallOrder[0]!;
    const answered = vi.mocked(deps.events.answerTakeoverRequest).mock.invocationCallOrder[0]!;
    expect(deps.events.releaseUserControl).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "lease-1" }),
    );
    expect(released).toBeLessThan(answered);
    expect(prisma.computer.updateMany).not.toHaveBeenCalled();
  });

  it("leaves newer control alone when a late hand back names an older lease", async () => {
    const { deps, call } = setup({ ...controlled, controlUserId: "user-1" });
    await expect(call("release", { leaseId: "old-lease" })).resolves.toMatchObject({
      status: 200,
    });
    expect(deps.events.releaseUserControl).not.toHaveBeenCalled();
    await expect(call("release", { leaseId: "lease-1" })).resolves.toMatchObject({ status: 200 });
    expect(deps.events.releaseUserControl).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "lease-1" }),
    );
  });

  it("hands control back on I'm done even when nothing is waiting any more", async () => {
    const { deps, call } = setup({ ...controlled, controlUserId: "user-1" });
    await expect(call("release", { reason: "done" })).resolves.toMatchObject({ status: 200 });
    expect(deps.events.releaseUserControl).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "lease-1" }),
    );
    expect(deps.events.answerTakeoverRequest).not.toHaveBeenCalled();
  });

  it("takes control afresh when the held lease lapsed before it could be renewed", async () => {
    const { prisma, call } = setup({ ...controlled, controlUserId: "user-1" });
    const held = (await prisma.bot.findFirst({} as never)) as unknown as { computer: object };
    // The lease lapsed meanwhile: the renew finds nothing live, and the computer is free again.
    vi.mocked(prisma.computer.updateMany).mockResolvedValueOnce({ count: 0 });
    vi.mocked(prisma.bot.findFirst)
      .mockResolvedValueOnce(held as never)
      .mockResolvedValue({
        ...held,
        computer: {
          ...held.computer,
          controlHolder: "none",
          controlLeaseId: null,
          controlLeaseExpiresAt: null,
          controlBotId: null,
        },
      } as never);
    const response = await call("takeover", {});
    expect(response).toMatchObject({ status: 200 });
    expect((response.body as { json: { leaseId: string } }).json.leaseId).not.toBe("lease-1");
    expect(vi.mocked(prisma.computer.updateMany).mock.calls[1]?.[0].data).toMatchObject({
      controlHolder: "user",
      controlUserId: "user-1",
    });
  });

  it("returns the holder's own lease to a second Take control", async () => {
    const held = { ...controlled, controlUserId: "user-1" };
    const { prisma, call } = setup();
    vi.mocked(prisma.computer.updateMany).mockResolvedValueOnce({ count: 0 });
    vi.mocked(prisma.computer.findUniqueOrThrow).mockResolvedValue({
      id: "computer-1",
      ...held,
    } as never);
    await expect(call("takeover", {})).resolves.toMatchObject({
      status: 200,
      body: { json: { leaseId: "lease-1" } },
    });
  });

  it("renews the holder's control each time their page checks in", async () => {
    const soon = new Date(Date.now() + 5_000);
    const { prisma, call } = setup({
      ...controlled,
      controlUserId: "user-1",
      controlLeaseExpiresAt: soon,
    });
    await expect(call("heartbeat", {})).resolves.toMatchObject({ status: 200 });
    expect(prisma.computer.updateMany).toHaveBeenCalledWith({
      where: {
        id: "computer-1",
        controlHolder: "user",
        controlLeaseId: "lease-1",
        // Only a live lease renews; a lapsed one is on its way to revocation.
        controlLeaseExpiresAt: { gt: expect.any(Date) },
      },
      data: { controlLeaseExpiresAt: expect.any(Date) },
    });
  });

  it("does not renew someone else's control from a watcher's check-in", async () => {
    const { prisma, call } = setup({ ...controlled, controlUserId: "user-2" });
    await expect(call("heartbeat", {})).resolves.toMatchObject({ status: 200 });
    expect(prisma.computer.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: { controlLeaseExpiresAt: expect.any(Date) },
      }),
    );
  });

  it("prepares the bot's folders when boot reuses an already running Team Computer", async () => {
    const { sandbox, call } = setup();
    await expect(call("boot", {})).resolves.toMatchObject({ status: 200 });
    expect(sandbox.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sandbox-ref-1" }),
      { argv: ["mkdir", "-p", "shared", "bots/bot-1"] },
      expect.anything(),
    );
  });

  it("clears a reclaimed sandbox before boot attempts provisioning again", async () => {
    const { sandbox, prisma, call } = setup();
    sandbox.execute.mockImplementation(async function* () {
      yield await Promise.reject(
        Object.assign(new Error("Sandbox is probably not running anymore"), {
          name: "SandboxNotFoundError",
        }),
      );
    });
    const findUniqueOrThrow = vi.fn().mockRejectedValue(new ComputerBusyError());
    prisma.computer.findUniqueOrThrow = findUniqueOrThrow;

    await expect(call("boot", {})).resolves.toMatchObject({ status: 409 });
    expect(prisma.computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", providerRef: "sandbox-ref-1" },
      data: { state: "stopped", providerRef: null },
    });
    expect(findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: "computer-1" } });
  });

  it("does not discard a live sandbox when folder preparation fails", async () => {
    const { sandbox, prisma, call } = setup();
    sandbox.execute.mockImplementation(async function* () {
      yield { type: "exit" as const, code: 1 };
    });
    await expect(call("boot", {})).resolves.toMatchObject({ status: 500 });
    expect(prisma.computer.updateMany).not.toHaveBeenCalled();
  });

  it("opens a terminal only for the user holding this bot's control lease", async () => {
    const released = setup();
    await expect(released.call("terminalUrl", {})).resolves.toMatchObject({ status: 403 });
    expect(released.sandbox.connectTerminal).not.toHaveBeenCalled();

    const { sandbox, call } = setup(controlled);
    const { status, body } = await call("terminalUrl", {});
    expect(status).toBe(200);
    expect(sandbox.connectTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sandbox-ref-1" }),
      { controlToken: "lease-1", cwd: "bots/bot-1" },
      expect.anything(),
    );
    const url = new URL(body.json.url);
    expect(url.origin).toBe("http://127.0.0.1:5173");
    expect(openScreenCapability(url.pathname, "fake-test-secret")).toMatchObject({
      scope: { botId: "bot-1", controlLeaseId: "lease-1" },
      target: { hostname: "screen.example", interactive: true },
    });
  });

  it("clears the row when the provider reclaimed the sandbox before the terminal opened", async () => {
    const gone = setup(controlled);
    gone.sandbox.connectTerminal.mockRejectedValueOnce(
      Object.assign(new Error("Sandbox is probably not running anymore"), {
        name: "SandboxNotFoundError",
      }),
    );
    await expect(gone.call("terminalUrl", {})).resolves.toEqual({
      status: 200,
      body: { json: { url: null } },
    });
    expect(gone.prisma.computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", providerRef: "sandbox-ref-1" },
      data: { state: "stopped", providerRef: null },
    });

    const blip = setup(controlled);
    blip.sandbox.connectTerminal.mockRejectedValueOnce(new Error("fetch failed"));
    await expect(blip.call("terminalUrl", {})).resolves.toMatchObject({ status: 500 });
    expect(blip.prisma.computer.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { state: "stopped", providerRef: null } }),
    );
  });

  it("offers no terminal on host computers", async () => {
    const { sandbox, call } = setup({ ...controlled, kind: "desktop" });
    await expect(call("terminalUrl", {})).resolves.toEqual({
      status: 200,
      body: { json: { url: null } },
    });
    expect(sandbox.connectTerminal).not.toHaveBeenCalled();
  });

  it("enforces the configured computer upload limit and advertises it to the sandbox", async () => {
    const limit = 1024 * 1024;
    const { call, sandbox } = setup(controlled, limit);
    await expect(
      call("uploadFile", {
        path: "notes.txt",
        contentBase64: Buffer.alloc(limit + 1).toString("base64"),
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { json: { message: "File exceeds the 1 MiB upload limit." } },
    });
    expect(sandbox.writeFile).not.toHaveBeenCalled();
    await expect(
      call("uploadFile", {
        path: "notes.txt",
        contentBase64: Buffer.alloc(limit).toString("base64"),
      }),
    ).resolves.toMatchObject({ status: 200 });
    await call("downloadFile", { path: "notes.txt" });
    expect(sandbox.readFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { maxBytes: limit },
    );
  });

  it("uploads into the bot workspace only under control", async () => {
    const contentBase64 = Buffer.from("notes").toString("base64");
    const released = setup();
    await expect(
      released.call("uploadFile", { path: "notes.txt", contentBase64 }),
    ).resolves.toMatchObject({ status: 403 });
    expect(released.sandbox.writeFile).not.toHaveBeenCalled();

    const { sandbox, call } = setup(controlled);
    await expect(call("uploadFile", { path: "notes.txt", contentBase64 })).resolves.toMatchObject({
      status: 200,
    });
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sandbox-ref-1" }),
      { path: "bots/bot-1/notes.txt", content: Buffer.from("notes") },
      expect.anything(),
    );
  });

  it("rejects team uploads into another bot workspace", async () => {
    const contentBase64 = Buffer.from("x").toString("base64");
    const { sandbox, call } = setup(controlled);
    await expect(
      call("uploadFile", { path: "bots/bot-2/secret.txt", contentBase64 }),
    ).resolves.toMatchObject({ status: 400 });
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it("answers 400 when a running computer's file is too large or not text to preview", async () => {
    const large = setup();
    large.sandbox.readFile.mockRejectedValueOnce(new SandboxFileTooLargeError(2 * 1024 * 1024));
    await expect(large.call("readFile", { path: "big.log" })).resolves.toMatchObject({
      status: 400,
      body: { json: { code: "BAD_REQUEST", message: "file is too large to preview" } },
    });

    const binary = setup();
    binary.sandbox.readFile.mockResolvedValueOnce(new Uint8Array([0xff, 0xfe, 0x00]));
    await expect(binary.call("readFile", { path: "image.bin" })).resolves.toMatchObject({
      status: 400,
      body: { json: { message: "file is not a text file" } },
    });

    const text = setup();
    await expect(text.call("readFile", { path: "notes.txt" })).resolves.toEqual({
      status: 200,
      body: { json: { path: "notes.txt", content: "hello" } },
    });
  });

  it("answers 404 when a stopped computer's file is gone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-computer-read-"));
    try {
      const { call } = setup({ state: "stopped" }, undefined, new LocalAgentHomeStore(root));
      await expect(call("readFile", { path: "gone.json" })).resolves.toMatchObject({
        status: 404,
        body: { json: { message: "file not found" } },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("answers 400 when a stopped computer's file is too large to preview", async () => {
    const home = new LocalAgentHomeStore(tmpdir());
    vi.spyOn(home, "readFile").mockRejectedValueOnce(new SandboxFileTooLargeError(1024));
    const { call } = setup({ state: "stopped" }, undefined, home);
    await expect(call("readFile", { path: "big.log" })).resolves.toMatchObject({
      status: 400,
      body: { json: { code: "BAD_REQUEST", message: "file is too large to preview" } },
    });
  });

  it("reports a stopped computer's read failure that only mentions a size as a fault", async () => {
    const home = new LocalAgentHomeStore(tmpdir());
    vi.spyOn(home, "readFile").mockRejectedValueOnce(
      new Error("agent home file exceeds 1024 bytes"),
    );
    const { call } = setup({ state: "stopped" }, undefined, home);
    await expect(call("readFile", { path: "big.log" })).resolves.toMatchObject({ status: 500 });
  });

  it("downloads bytes from a running computer", async () => {
    const { sandbox, call } = setup();
    await expect(call("downloadFile", { path: "notes.txt" })).resolves.toEqual({
      status: 200,
      body: { json: { path: "notes.txt", contentBase64: Buffer.from("hello").toString("base64") } },
    });
    expect(sandbox.readFile).toHaveBeenCalledWith(
      expect.anything(),
      "bots/bot-1/notes.txt",
      expect.anything(),
      { maxBytes: 10 * 1024 * 1024 },
    );
    const stopped = setup({ state: "stopped" });
    await expect(stopped.call("downloadFile", { path: "notes.txt" })).resolves.toMatchObject({
      status: 409,
    });
  });

  it("answers 400 when a running computer's file is over the download limit", async () => {
    const { sandbox, call } = setup();
    sandbox.readFile.mockRejectedValueOnce(new SandboxFileTooLargeError(10 * 1024 * 1024));
    await expect(call("downloadFile", { path: "big.zip" })).resolves.toMatchObject({
      status: 400,
      body: { json: { code: "BAD_REQUEST", message: "File exceeds the 10 MiB download limit." } },
    });
  });

  it.each(["readFile", "downloadFile"] as const)(
    "reports a computer failure that only mentions a size as a fault from %s",
    async (route) => {
      for (const message of ["request entity too large", "command output exceeds the buffer"]) {
        const { sandbox, call } = setup();
        sandbox.readFile.mockRejectedValueOnce(new Error(message));
        await expect(call(route, { path: "notes.txt" })).resolves.toMatchObject({ status: 500 });
      }
    },
  );
});

describe("quarantined computer stop", () => {
  it.each(["already-quarantined", "before-claim", "during-stop"])(
    "preserves the recovery fence (%s)",
    async (race) => {
      const row = {
        id: "computer",
        kind: "novita",
        providerRef: "guest",
        homeKey: "home",
        scope: "dedicated",
        state: race === "already-quarantined" ? "quarantined" : "running",
        controlHolder: "none",
        controlLeaseId: null,
        controlBotId: null,
        homeRevision: "saved",
        screenGeneration: 1,
      };
      const endRun = vi.fn();
      const updateMany = vi.fn(async ({ where, data }) => {
        if (race === "before-claim") row.state = "quarantined";
        if (typeof where.state === "string" && where.state !== row.state) return { count: 0 };
        if (where.state?.notIn?.includes(row.state)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      });
      const prisma = {
        spaceMember: { count: vi.fn(async () => 1) },
        bot: {
          findFirst: vi.fn(async () => {
            const snapshot = { ...row };
            return {
              id: "bot",
              spaceId: "space",
              userId: "user",
              screenGeneration: 1,
              thread: { id: "thread" },
              computer: snapshot,
            };
          }),
        },
        computer: { updateMany },
        computerRun: { updateMany: endRun },
        computerExecutionLease: {
          updateMany: vi.fn(async () => ({ count: 0 })),
          findUnique: vi.fn(async () => null),
        },
        run: { findFirst: vi.fn(async () => null) },
      } as unknown as PrismaClient;
      const checkpoint = vi
        .spyOn(adapters, "checkpointAndStopComputer")
        .mockImplementation(async () => {
          if (race === "during-stop") row.state = "quarantined";
        });
      const deps = {
        prisma,
        sandbox: { stop: vi.fn(async () => undefined) },
        jobs: { cancel: vi.fn(async () => undefined) },
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          sandboxProvider: "novita",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "test-secret",
        },
      } as unknown as RouterDeps;
      try {
        const handler = new RPCHandler(createRouter(deps));
        const response = await handle(
          handler,
          new Request("http://127.0.0.1/rpc/computer/stop", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json: { botId: "bot" } }),
          }),
          {
            prefix: "/rpc",
            context: {
              actor: {
                userId: "user",
                spaceId: "space",
                email: "user@rakazo.test",
                isDeploymentOwner: true,
              },
            },
          },
        );
        expect(response.status).toBe(race === "before-claim" ? 409 : 200);
        expect(row.state).toBe("quarantined");
        expect(endRun).not.toHaveBeenCalled();
        if (race !== "during-stop") expect(checkpoint).not.toHaveBeenCalled();
      } finally {
        checkpoint.mockRestore();
      }
    },
  );
});

describe("bot restore computer quota", () => {
  function fixture(archivedBot: { archivedAt: Date | null } | null, inUse = 0) {
    const bot = archivedBot
      ? {
          ...archivedBot,
          id: "bot-archived",
          computerId: "computer-archived",
          computer: { id: "computer-archived" },
          userId: "user-1",
        }
      : null;
    const botApi = {
      findFirst: vi.fn(async () => bot),
      update: vi.fn(async () => ({})),
    };
    const computer = {
      count: vi.fn(async (args: { where: { id?: string } }) => (args.where.id ? 0 : inUse)),
    };
    const $queryRaw = vi.fn(async () => [{ lock: "1" }]);
    const prisma = {
      bot: botApi,
      computer,
      $queryRaw,
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({ $queryRaw, computer, bot: botApi }),
      ),
    };
    const handler = new RPCHandler(
      createRouter({ prisma, env: { sandboxProvider: "fake" } } as unknown as RouterDeps),
      {
        // As the app does, so a domain error answers with its own status.
        clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))],
      },
    );
    const call = async () =>
      handle(
        handler,
        new Request("http://127.0.0.1/rpc/bots/restore", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { botId: "bot-archived" } }),
        }),
        {
          prefix: "/rpc",
          context: {
            actor: {
              spaceId: "space-1",
              userId: "user-1",
              email: "user@rakazo.test",
              isDeploymentOwner: true,
            },
          },
        },
      );
    return { prisma, call };
  }

  it("archives, creates, then restores is refused when the restore would exceed the cap", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const { prisma, call } = fixture({ archivedAt: new Date() }, 1);
    const response = await call();
    expect(response.status).toBe(400);
    expect(prisma.bot.update).not.toHaveBeenCalled();
  });

  it("restores normally when the user is below the cap or the computer is already live", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const { prisma, call } = fixture({ archivedAt: new Date() }, 0);
    const response = await call();
    expect(response.status).toBe(200);
    expect(prisma.bot.update).toHaveBeenCalledWith({
      where: { id: "bot-archived" },
      data: { archivedAt: null },
    });
  });

  it("does not enforce anything when the cap is unset", async () => {
    const { prisma, call } = fixture({ archivedAt: new Date() }, 99);
    const response = await call();
    expect(response.status).toBe(200);
    expect(prisma.bot.update).toHaveBeenCalledOnce();
  });
});
