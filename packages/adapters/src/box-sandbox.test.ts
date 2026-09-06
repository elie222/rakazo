import type { Command200Response } from "@asciidev/box-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  BoxSandboxProvider,
  type BoxSandboxSdk,
  isUnrecoverableBoxError,
  shouldStopBoxBrowsersOnCancel,
} from "./box-sandbox.js";

const context = {
  operationId: "test",
  traceId: "trace",
  spaceId: "workspace",
  userId: "user",
  botId: "bot-a",
  signal: new AbortController().signal,
};

describe("BoxSandboxProvider", () => {
  it("creates no-env boxes and implements execution and file operations", async () => {
    const fixture = boxFixture();
    const provider = new BoxSandboxProvider({ apiKey: "test-key" }, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);

    expect(computer).toMatchObject({
      id: "bx_testbox2",
      providerRef: "bx_testbox2",
      kind: "box",
      fresh: true,
    });
    expect(fixture.create).toHaveBeenCalledWith(
      {
        createBoxRequest: {
          ttlSeconds: 7200,
          noEnv: true,
          env: { RAKAZO_BOT_ID: "bot-a", RAKAZO_SANDBOX: "computer" },
        },
      },
      { signal: context.signal },
    );

    await provider.prepare(computer, context);
    expect(
      fixture.command.mock.calls.some(([request]) =>
        request.commandRequest.command.includes("rakazo-home/.browser-profiles"),
      ),
    ).toBe(true);

    const events = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["echo", "hello"], cwd: "notes", env: { TEST_VALUE: "works" } },
      context,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "stdout", data: "hello\n" },
      { type: "exit", code: 0 },
    ]);
    const executeRequest = fixture.command.mock.calls.find(([request]) =>
      request.commandRequest.command.includes("TEST_VALUE=works"),
    )?.[0];
    expect(executeRequest?.commandRequest.cwd).toBe("rakazo-home/notes");

    await provider.writeFile(
      computer,
      { path: "bin/tool", content: Uint8Array.from([0, 255, 1]), executable: true },
      context,
    );
    expect(await provider.readFile(computer, "bin/tool", context)).toEqual(
      Uint8Array.from([0, 255, 1]),
    );
    expect(await provider.listFiles(computer, "bin", context)).toEqual([
      { path: "bin/tool", kind: "file", size: 3, executable: true },
    ]);
    const exported = [];
    for await (const file of provider.exportWorkspace(computer, context)) exported.push(file);
    expect(exported).toEqual([
      { path: "bin/tool", content: Uint8Array.from([0, 255, 1]), executable: true },
    ]);
  });

  it("resumes archived boxes and replaces deleted references", async () => {
    const archived = boxFixture({ state: "archived" });
    const provider = new BoxSandboxProvider({ apiKey: "test-key" }, archived.client);
    const reconnected = await provider.provision(
      {
        botId: "bot-a",
        homePath: "/unused",
        providerRef: "bx_existing2",
        providerKind: "box",
      },
      context,
    );
    expect(reconnected).toMatchObject({ providerRef: "bx_existing2", fresh: false });
    expect(archived.resume).toHaveBeenCalledWith(
      {
        boxId: "bx_existing2",
        resumeRequest: { noEnv: true, ttlSeconds: 7200 },
      },
      { signal: context.signal },
    );

    const missing = boxFixture();
    missing.get.mockRejectedValueOnce({ status: 404 });
    const replacing = new BoxSandboxProvider({ apiKey: "test-key" }, missing.client);
    const replacement = await replacing.provision(
      {
        botId: "bot-b",
        homePath: "/unused",
        providerRef: "bx_missing2",
        providerKind: "box",
      },
      context,
    );
    expect(replacement).toMatchObject({ providerRef: "bx_testbox2", fresh: true });
  });

  it("downloads binary files over the JSON endpoint limit through the SDK artifact route", async () => {
    const content = Buffer.alloc(6 * 1024 * 1024, 0xff);
    content[0] = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(content, { headers: { "content-length": String(content.byteLength) } }),
      );
    try {
      const provider = new BoxSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://box.test/api/box/v1",
      });
      const computer = {
        id: "bx_testbox2",
        providerRef: "bx_testbox2",
        kind: "box" as const,
        botId: "bot-a",
      };
      const filePath = "notes/a file & more.bin";
      const downloaded = await provider.readFile(computer, filePath, context);

      expect(Buffer.from(downloaded).equals(content)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [request, init] = fetchMock.mock.calls[0]!;
      const url = new URL(String(request));
      expect(url.pathname).toBe("/api/box/v1/boxes/bx_testbox2/artifacts");
      expect(url.searchParams.get("path")).toBe(`/home/user/rakazo-home/${filePath}`);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-key");
      expect(init?.signal).toBe(context.signal);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("exports browser profile files over 5 MiB without losing their bytes", async () => {
    const fixture = boxFixture();
    const content = Buffer.alloc(6 * 1024 * 1024, 0xab);
    fixture.files.set("/home/user/rakazo-home/.browser-profiles/chrome/Default/History", content);
    const provider = new BoxSandboxProvider({ apiKey: "test-key" }, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    const exported = [];
    for await (const file of provider.exportWorkspace(computer, context)) exported.push(file);

    expect(exported).toHaveLength(1);
    expect(exported[0]?.path).toBe(".browser-profiles/chrome/Default/History");
    expect(Buffer.from(exported[0]!.content).equals(content)).toBe(true);
    expect(fixture.artifactRaw).toHaveBeenCalledWith(
      {
        boxId: computer.id,
        path: "/home/user/rakazo-home/.browser-profiles/chrome/Default/History",
      },
      { signal: context.signal },
    );
  });

  it.each([undefined, "1", "20"])(
    "cancels oversized downloads with content-length %s",
    async (contentLength) => {
      const fixture = boxFixture();
      const cancel = vi.fn();
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(Uint8Array.from([1, 2, 3]));
      });
      const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
      fixture.artifactRaw.mockResolvedValueOnce({
        raw: new Response(body, {
          headers: contentLength ? { "content-length": contentLength } : undefined,
        }),
      });
      const provider = new BoxSandboxProvider({ apiKey: "test-key" }, fixture.client);
      const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);

      await expect(
        provider.readFile(computer, "large.bin", context, { maxBytes: 4 }),
      ).rejects.toThrow("computer file exceeds 4 bytes");
      expect(pull).toHaveBeenCalledTimes(contentLength === "20" ? 0 : 2);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
    },
  );

  it("accepts empty files and files exactly at the download limit", async () => {
    const fixture = boxFixture();
    fixture.files.set("/home/user/rakazo-home/exact.bin", Uint8Array.from([0, 255]));
    const provider = new BoxSandboxProvider({ apiKey: "test-key" }, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);

    expect(await provider.readFile(computer, "empty.bin", context, { maxBytes: 0 })).toHaveLength(
      0,
    );
    expect(await provider.readFile(computer, "exact.bin", context, { maxBytes: 2 })).toEqual(
      Uint8Array.from([0, 255]),
    );
  });

  it("propagates interrupted downloads instead of returning partial files", async () => {
    const fixture = boxFixture();
    const aborted = new DOMException("download aborted", "AbortError");
    let first = true;
    const body = new ReadableStream({
      pull(controller) {
        if (first) controller.enqueue(Uint8Array.from([1, 2, 3]));
        else controller.error(aborted);
        first = false;
      },
    });
    fixture.artifactRaw.mockResolvedValueOnce({ raw: new Response(body) });
    const provider = new BoxSandboxProvider({ apiKey: "test-key" }, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);

    await expect(provider.readFile(computer, "partial.bin", context)).rejects.toBe(aborted);
    expect(body.locked).toBe(false);
  });

  it("captures the desktop, exposes a private view, and enforces one screen", async () => {
    const fixture = boxFixture();
    const provider = new BoxSandboxProvider({ apiKey: "test-key" }, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await provider.prepare(computer, context);

    const observation = await provider.observe(computer, context);
    expect(observation).toMatchObject({
      mimeType: "image/png",
      width: 1920,
      height: 1080,
      cursor: { x: 21, y: 34 },
      activeWindow: { id: "42", title: "Box browser" },
    });
    expect(observation.image).toEqual(Uint8Array.from([137, 80, 78, 71]));

    const screen = await provider.connectScreen(
      computer,
      { view: "stream", interactive: false },
      context,
    );
    expect(screen.url).toContain("view_only=true");
    expect(screen.url).toContain("_token=secret");

    await provider.act(
      computer,
      { actions: [{ kind: "pointer", type: "click", x: 100, y: 200 }], observe: false },
      context,
    );
    expect(
      fixture.command.mock.calls.some(([request]) =>
        request.commandRequest.command.includes("xdotool mousemove 100 200 click 1"),
      ),
    ).toBe(true);

    await expect(provider.observe(computer, { ...context, botId: "bot-b" })).rejects.toThrow(
      /temporarily busy/i,
    );
    expect(provider.describe().capabilities.multiScreen).toBe(false);
  });

  it("releases the screen claim when desktop connection fails", async () => {
    const fixture = boxFixture();
    fixture.desktop.mockRejectedValueOnce(new Error("desktop unavailable"));
    const provider = new BoxSandboxProvider({ apiKey: "test-key" }, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);

    await expect(
      provider.connectScreen(computer, { view: "stream", interactive: false }, context),
    ).rejects.toThrow("desktop unavailable");
    await expect(provider.observe(computer, { ...context, botId: "bot-b" })).resolves.toMatchObject(
      { width: 1920, height: 1080 },
    );
  });

  it("archives on stop and permanently deletes on destroy", async () => {
    const fixture = boxFixture();
    const provider = new BoxSandboxProvider({ apiKey: "test-key" }, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    fixture.stop.mockResolvedValueOnce(actionResponse("archiving"));
    fixture.get
      .mockResolvedValueOnce(infoResponse("bx_testbox2", "ready"))
      .mockResolvedValue(infoResponse("bx_testbox2", "archived"));

    await provider.stop(computer, context);
    expect(fixture.stop).toHaveBeenCalledWith({ boxId: "bx_testbox2" }, { signal: context.signal });
    await provider.destroy(computer, context);
    expect(fixture.deleteBox).toHaveBeenCalledWith("bx_testbox2");
  });

  it("recognizes provider 404 errors without swallowing transient failures", () => {
    expect(isUnrecoverableBoxError({ status: 404 })).toBe(true);
    expect(isUnrecoverableBoxError(new Error("temporary Box outage"))).toBe(false);
  });
});

function boxFixture(options: { state?: string } = {}) {
  const files = new Map<string, Uint8Array>();
  const create = vi.fn(async () => createResponse());
  const fixture = {
    state: options.state ?? "ready",
    create,
    get: vi.fn(async ({ boxId }: { boxId: string }) => infoResponse(boxId, fixture.state)),
    resume: vi.fn(async ({ boxId }: { boxId: string }) => {
      fixture.state = "ready";
      return actionResponse("ready", boxId);
    }),
    stop: vi.fn(async ({ boxId }: { boxId: string }) => actionResponse("archiving", boxId)),
    update: vi.fn(async ({ boxId }: { boxId: string }) => infoResponse(boxId, fixture.state)),
    deleteBox: vi.fn(async () => undefined),
    desktop: vi.fn(async () => ({
      ok: true,
      type: "desktop.url",
      success: true,
      desktopUrl: "https://vnc.box.test/vnc.html?password=pw&_token=secret",
      mode: "vnc",
    })),
    commandStatus: vi.fn(),
    command: vi.fn(async (request: { commandRequest: { command: string; cwd?: string } }) => {
      const command = request.commandRequest.command;
      if (command.includes("TEST_VALUE=works")) return finished({ stdout: "hello\n" });
      if (command.includes("find ") && command.includes("rakazo-home/bin")) {
        const target = "/home/user/rakazo-home/bin/tool";
        return finished({
          stdout: `${Buffer.from(target).toString("base64")}\tfile\t3\t1\n`,
        });
      }
      if (
        command.includes("find ") &&
        command.includes("rakazo-home") &&
        command.includes("-type f")
      ) {
        const stdout = [...files.entries()]
          .filter(([filePath]) => filePath.startsWith("/home/user/rakazo-home/"))
          .map(([filePath, content]) => {
            const executable = filePath.endsWith("/bin/tool") ? "1" : "0";
            return `${Buffer.from(filePath).toString("base64")}\tfile\t${content.byteLength}\t${executable}\n`;
          })
          .join("");
        return finished({ stdout });
      }
      if (command.includes("import -window root")) {
        return finished({
          stdout: [
            "WIDTH=1920",
            "HEIGHT=1080",
            "X=21",
            "Y=34",
            "WINDOW=42",
            `TITLE=${Buffer.from("Box browser").toString("base64")}`,
            "",
          ].join("\n"),
        });
      }
      return finished();
    }),
    writeFile: vi.fn(
      async ({ fileWriteRequest }: { fileWriteRequest: { path: string; content: string } }) => {
        files.set(
          fileWriteRequest.path,
          Uint8Array.from(Buffer.from(fileWriteRequest.content, "base64")),
        );
        return {
          ok: true,
          type: "file.written" as const,
          success: true,
          path: fileWriteRequest.path,
          encoding: "base64" as const,
          size: files.get(fileWriteRequest.path)?.byteLength ?? 0,
        };
      },
    ),
    artifactRaw: vi.fn(async ({ path }: { path: string }) => {
      const content = path.startsWith("/tmp/rakazo-observe-")
        ? Uint8Array.from([137, 80, 78, 71])
        : (files.get(path) ?? new Uint8Array());
      return { raw: new Response(Buffer.from(content)) };
    }),
  };
  return { ...fixture, files, client: fixture as unknown as BoxSandboxSdk };
}

function box(id: string, state: string) {
  return {
    id,
    name: "Test Box",
    state,
    desktopAvailable: true,
    snapshotAvailable: state === "archived",
  };
}

function createResponse() {
  return {
    ok: true,
    type: "box.created",
    status: "provisioning",
    ttlSeconds: null,
    box: box("bx_testbox2", "provisioning"),
  };
}

function infoResponse(id: string, state: string) {
  return { ok: true, type: "box.info", box: box(id, state) };
}

function actionResponse(status: string, id = "bx_testbox2") {
  return { ok: true, type: "box.action", id, status, box: box(id, status) };
}

function finished(overrides: Partial<Command200Response> = {}): Command200Response {
  return {
    ok: true,
    type: "command.finished",
    success: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...overrides,
  } as Command200Response;
}

describe("shouldStopBoxBrowsersOnCancel", () => {
  it("keeps a newer remote fence alive even if a local claim was released", () => {
    expect(
      shouldStopBoxBrowsersOnCancel({
        remoteLease: { status: "present", leaseId: "run-2:2" },
        screenLeaseId: "run-1:1",
      }),
    ).toBe(false);
  });

  it("stops cross-process cancel when the remote fence matches", () => {
    expect(
      shouldStopBoxBrowsersOnCancel({
        remoteLease: { status: "present", leaseId: "run-1:1" },
        screenLeaseId: "run-1:1",
      }),
    ).toBe(true);
  });

  it("stops orphaned browsers when no remote fence exists", () => {
    expect(
      shouldStopBoxBrowsersOnCancel({
        remoteLease: { status: "missing" },
        screenLeaseId: "run-1:1",
      }),
    ).toBe(true);
  });

  it("fails closed when the remote lease cannot be read", () => {
    expect(
      shouldStopBoxBrowsersOnCancel({
        remoteLease: { status: "error" },
        screenLeaseId: "run-1:1",
      }),
    ).toBe(false);
  });

  it("fails closed when cancel has no screen lease id", () => {
    expect(
      shouldStopBoxBrowsersOnCancel({
        remoteLease: { status: "present", leaseId: "run-1:1" },
      }),
    ).toBe(false);
  });
});
