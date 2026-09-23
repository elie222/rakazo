import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ComputerRef, PortableFile, ProcessEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  CREATEOS_SCREEN_MAP_SCRIPT,
  CREATEOS_SCREEN_MAP_SENTINEL,
  CreateOSSandboxProvider,
  isAllowedCreateOSScreenUrl,
  MAX_CREATEOS_ERROR_RESPONSE_BYTES,
  MAX_CREATEOS_SUCCESS_RESPONSE_BYTES,
} from "./createos-sandbox.js";

const execFileAsync = promisify(execFile);

const context = {
  operationId: "test",
  traceId: "trace",
  workspaceId: "workspace",
  spaceId: "workspace",
  userId: "user",
  botId: "bot-a",
  signal: new AbortController().signal,
};

const WORKSPACE_LISTING = JSON.stringify([
  { name: "notes.txt", kind: "file", size: 5, executable: false },
]);

interface ExecCall {
  path: string;
  command: string;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ status: "success", data }), {
    headers: { "content-type": "application/json" },
  });
}

function shellArgs(command: string): string[] {
  const args: string[] = [];
  for (const match of command.matchAll(/'([^']*)'/g)) args.push(match[1] ?? "");
  return args;
}

/** Route-driven CreateOS control-plane double. Exec replies are keyed off the shell command. */
function createosFixture(options: { statuses?: string[]; connectionUrl?: string } = {}) {
  const statuses = [...(options.statuses ?? ["running"])];
  const calls: string[] = [];
  const execs: ExecCall[] = [];
  const screenMapPath = path.join(
    mkdtempSync(path.join(tmpdir(), "createos-screens-")),
    "screens.json",
  );
  let nextScreen = 1;
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const route = `${method} ${url.pathname}`;
    calls.push(route);

    if (route === "POST /v1/sandboxes") {
      return jsonResponse({ id: "sbx-1", status: statuses[0] ?? "running" });
    }
    if (method === "GET" && /^\/v1\/sandboxes\/[^/]+$/.test(url.pathname)) {
      return jsonResponse({ id: "sbx-1", status: statuses.shift() ?? "running" });
    }
    if (method === "POST" && url.pathname.endsWith("/exec")) {
      const body = JSON.parse(String(init?.body)) as { args: string[] };
      const command = body.args[3] ?? "";
      execs.push({ path: url.pathname, command });
      if (command.includes(CREATEOS_SCREEN_MAP_SENTINEL)) {
        const args = shellArgs(command);
        const at = args.indexOf(CREATEOS_SCREEN_MAP_SENTINEL);
        const stdout = execFileSync(
          "python3",
          [
            "-c",
            args[at - 1] ?? "",
            args[at] ?? "",
            args[at + 1] ?? "",
            args[at + 2] ?? "",
            args[at + 3] ?? "",
            screenMapPath,
          ],
          { encoding: "utf8" },
        );
        return jsonResponse({ result: { stdout, exit_code: 0 } });
      }
      if (command.includes("os.listdir")) {
        return jsonResponse({ result: { stdout: WORKSPACE_LISTING, exit_code: 0 } });
      }
      // Both browser probes talk to a devtools port that the double does not run.
      if (command.includes("127.0.0.1:9222")) {
        return jsonResponse({ result: { stdout: "", exit_code: 1 } });
      }
      return jsonResponse({ result: { stdout: "hello\n", exit_code: 0 } });
    }
    if (method === "POST" && url.pathname.endsWith("/computer/screens")) {
      const screenId = `screen-${nextScreen}`;
      nextScreen += 1;
      return jsonResponse({ screen_id: screenId });
    }
    if (method === "GET" && url.pathname.endsWith("/connect")) {
      return jsonResponse(options.connectionUrl ? { url: options.connectionUrl, token: "t" } : {});
    }
    if (method === "GET" && url.pathname.endsWith("/files")) {
      return new Response(new TextEncoder().encode("notes"));
    }
    return jsonResponse({});
  }) as typeof fetch;

  return { calls, execs, fetchImpl };
}

function provider(fixture: ReturnType<typeof createosFixture>) {
  return new CreateOSSandboxProvider({ apiKey: "test-key", fetch: fixture.fetchImpl });
}

const computer: ComputerRef = {
  id: "sbx-1",
  botId: "bot-a",
  kind: "createos",
  providerRef: "sbx-1",
  fresh: true,
};

describe("CreateOSSandboxProvider", () => {
  it("creates a sandbox and waits until it runs", async () => {
    const fixture = createosFixture({ statuses: ["provisioning", "running"] });
    const ref = await provider(fixture).provision({ botId: "bot-a", homePath: "/unused" }, context);

    expect(ref).toMatchObject({ id: "sbx-1", providerRef: "sbx-1", kind: "createos", fresh: true });
    expect(fixture.calls.filter((call) => call === "GET /v1/sandboxes/sbx-1").length).toBe(2);
  });

  it("resumes a paused sandbox and waits for it", async () => {
    const fixture = createosFixture({ statuses: ["paused", "running"] });
    const ref = await provider(fixture).provision(
      { botId: "bot-a", homePath: "/unused", providerRef: "sbx-1", providerKind: "createos" },
      context,
    );

    expect(ref.fresh).toBe(false);
    expect(fixture.calls).toContain("POST /v1/sandboxes/sbx-1/resume");
    expect(fixture.calls).not.toContain("POST /v1/sandboxes");
  });

  it("lets a pausing sandbox settle before it resumes", async () => {
    const fixture = createosFixture({ statuses: ["pausing", "pausing", "paused", "running"] });
    const ref = await provider(fixture).provision(
      { botId: "bot-a", homePath: "/unused", providerRef: "sbx-1", providerKind: "createos" },
      context,
    );

    expect(ref.fresh).toBe(false);
    expect(fixture.calls).toContain("POST /v1/sandboxes/sbx-1/resume");
    expect(fixture.calls).not.toContain("POST /v1/sandboxes");
  });

  it("waits for an existing sandbox that is neither running nor paused", async () => {
    const fixture = createosFixture({ statuses: ["starting", "running"] });
    await provider(fixture).provision(
      { botId: "bot-a", homePath: "/unused", providerRef: "sbx-1", providerKind: "createos" },
      context,
    );

    expect(fixture.calls).not.toContain("POST /v1/sandboxes/sbx-1/resume");
    expect(fixture.calls.filter((call) => call === "GET /v1/sandboxes/sbx-1").length).toBe(2);
  });

  it("runs commands inside the workspace with the requested environment", async () => {
    const fixture = createosFixture();
    const events = [];
    for await (const event of provider(fixture).execute(
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
    const command = fixture.execs.at(-1)?.command ?? "";
    expect(command).toContain("cd '/home/desktop/rakazo-home/notes'");
    expect(command).toContain("TEST_VALUE='works'");
  });

  it("reports a timed-out command as exit code 124", async () => {
    const fetchImpl = (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    const events = [];
    for await (const event of new CreateOSSandboxProvider({
      apiKey: "test-key",
      fetch: fetchImpl,
    }).execute(computer, { argv: ["sleep", "600"] }, context)) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({ type: "exit", code: 124 });
    expect(events[0]).toMatchObject({ type: "stderr" });
  });

  it("exports the workspace after a graphical action alone", async () => {
    const fixture = createosFixture();
    const target = provider(fixture);
    await target.act(computer, { actions: [{ kind: "wait", ms: 0 }], observe: false }, context);

    const files: PortableFile[] = [];
    for await (const file of target.exportWorkspace(computer, context)) files.push(file);

    expect(files.map((file) => file.path)).toEqual(["notes.txt"]);
    expect(fixture.execs.some((exec) => exec.command.includes("os.lstat"))).toBe(true);
    expect(fixture.execs.some((exec) => exec.command.includes("S_ISLNK"))).toBe(true);
  });

  it("exports a resumed sandbox after the provider process restarts", async () => {
    const fixture = createosFixture();
    await provider(fixture).execute(computer, { argv: ["echo", "hi"] }, context);

    const files: PortableFile[] = [];
    for await (const file of provider(fixture).exportWorkspace(computer, context)) files.push(file);

    expect(files.map((file) => file.path)).toEqual(["notes.txt"]);
  });

  it("forgets per-sandbox state on stop and destroy", async () => {
    const fixture = createosFixture();
    const target = provider(fixture);
    await target.act(computer, { actions: [{ kind: "wait", ms: 0 }], observe: false }, context);
    await target.stop(computer, context);

    const afterStop: PortableFile[] = [];
    for await (const file of target.exportWorkspace(computer, context)) afterStop.push(file);
    expect(afterStop.map((file) => file.path)).toEqual(["notes.txt"]);

    await target.destroy(computer, context);
    expect(fixture.calls).toContain("DELETE /v1/sandboxes/sbx-1");
  });

  it("releases a control lease so expiry and demotion can finish", async () => {
    const fixture = createosFixture();
    const target = provider(fixture);

    await expect(
      target.setScreenControl(computer, false, context, "lease-1"),
    ).resolves.toBeUndefined();
    await expect(target.setScreenControl(computer, true, context)).rejects.toThrow(
      /interactive screen requires a control token/,
    );
    await expect(target.setScreenControl(computer, true, context, "lease-1")).rejects.toThrow(
      /CreateOS screen control changes are unsupported/,
    );
    await expect(target.setScreenControl(computer, false, context)).resolves.toBeUndefined();
    expect(fixture.calls).toEqual([]);
  });

  it("treats teardown of a missing sandbox as done", async () => {
    const gone = (async () =>
      new Response(JSON.stringify({ status: "error", message: "not found" }), {
        status: 404,
      })) as typeof fetch;
    const target = new CreateOSSandboxProvider({ apiKey: "test-key", fetch: gone });

    await expect(target.stop(computer, context)).resolves.toBeUndefined();
    await expect(target.destroy(computer, context)).resolves.toBeUndefined();
  });

  it("reports a cancelled command as an abort", async () => {
    const controller = new AbortController();
    const fixture = createosFixture();
    const aborting = (async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input).endsWith("/exec")) {
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      return fixture.fetchImpl(input, init);
    }) as typeof fetch;
    const target = new CreateOSSandboxProvider({ apiKey: "test-key", fetch: aborting });

    const events: ProcessEvent[] = [];
    for await (const event of target.execute(
      computer,
      { argv: ["sleep", "30"] },
      { ...context, signal: controller.signal },
    )) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({ type: "exit", code: 130 });
  });

  it("fails a command that reports an error without an exit code", async () => {
    const failing = (async (input: URL | RequestInfo) => {
      if (String(input).endsWith("/exec")) {
        return new Response(
          JSON.stringify({ status: "success", data: { result: { error: "no such file" } } }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ status: "success", data: { id: "sbx-1", status: "running" } }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
    const target = new CreateOSSandboxProvider({ apiKey: "test-key", fetch: failing });

    const events: ProcessEvent[] = [];
    for await (const event of target.execute(computer, { argv: ["cat", "missing"] }, context)) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({ type: "exit", code: 1 });
  });

  it("refuses a plaintext base url outside loopback", () => {
    expect(
      () => new CreateOSSandboxProvider({ apiKey: "test-key", baseUrl: "http://api.example.com" }),
    ).toThrow(/https/);
    expect(
      () => new CreateOSSandboxProvider({ apiKey: "test-key", baseUrl: "http://127.0.0.1:8080" }),
    ).not.toThrow();
  });

  it("rejects a declared oversized success response without buffering it", async () => {
    const cancel = vi.fn();
    const fetchImpl = (async () =>
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-length": String(MAX_CREATEOS_SUCCESS_RESPONSE_BYTES + 1) },
      })) as typeof fetch;

    await expect(
      new CreateOSSandboxProvider({ apiKey: "test-key", fetch: fetchImpl }).provision(
        { botId: "bot-a", homePath: "/unused" },
        context,
      ),
    ).rejects.toThrow(`CreateOS response exceeds ${MAX_CREATEOS_SUCCESS_RESPONSE_BYTES} bytes`);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("does not buffer an oversized error body", async () => {
    const cancel = vi.fn();
    const fetchImpl = (async () =>
      new Response(new ReadableStream({ cancel }), {
        status: 500,
        headers: { "content-length": String(MAX_CREATEOS_ERROR_RESPONSE_BYTES + 1) },
      })) as typeof fetch;

    await expect(
      new CreateOSSandboxProvider({ apiKey: "test-key", fetch: fetchImpl }).destroy(
        computer,
        context,
      ),
    ).rejects.toThrow(/500/);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("destroys a sandbox that never becomes running", async () => {
    const fixture = createosFixture({ statuses: ["failed"] });
    await expect(
      provider(fixture).provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).rejects.toThrow(/failed/);
    expect(fixture.calls).toContain("DELETE /v1/sandboxes/sbx-1");
  });

  it("refreshes auto-pause with an exec when keepAlive has no caller context", async () => {
    const fixture = createosFixture();
    await provider(fixture).keepAlive(computer);
    expect(fixture.execs.some((exec) => exec.command.includes(" 'true'"))).toBe(true);
    expect(fixture.calls.some((call) => call.startsWith("GET /v1/sandboxes/"))).toBe(false);
  });

  it("rejects a screen URL outside the CreateOS host allowlist", async () => {
    const fixture = createosFixture({
      connectionUrl: "https://evil.example/vnc.html?token=secret",
    });
    await expect(
      provider(fixture).connectScreen(computer, { view: "stream" }, context),
    ).rejects.toThrow(/host is not allowed/);
  });

  it("reuses one screen assignment across provider instances", async () => {
    const fixture = createosFixture({ connectionUrl: "/vnc.html" });
    const api = provider(fixture);
    const worker = new CreateOSSandboxProvider({ apiKey: "test-key", fetch: fixture.fetchImpl });
    const botA = { ...context, botId: "bot-a" };
    const botB = { ...context, botId: "bot-b" };

    const first = await api.connectScreen(computer, { view: "stream" }, botA);
    await worker.connectScreen(computer, { view: "stream" }, botA);
    expect(new URL(first.url ?? "").hostname).toBe("api.sb.createos.sh");
    expect(fixture.calls.filter((call) => call.endsWith("/computer/screens"))).toEqual([]);

    await worker.connectScreen(computer, { view: "stream" }, botB);
    expect(fixture.calls.filter((call) => call.endsWith("/computer/screens"))).toEqual([
      "POST /v1/sandboxes/sbx-1/computer/screens",
    ]);
  });

  it("does not export the screen-assignment directory", async () => {
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "POST" && url.pathname.endsWith("/exec")) {
        const command = (JSON.parse(String(init?.body)) as { args: string[] }).args[3] ?? "";
        if (command.includes("os.listdir")) {
          const listing = command.includes("/.rakazo")
            ? JSON.stringify([{ name: "screens.json", kind: "file", size: 2 }])
            : JSON.stringify([
                { name: ".rakazo", kind: "dir", size: 0 },
                { name: "notes.txt", kind: "file", size: 5 },
              ]);
          return jsonResponse({ result: { stdout: listing, exit_code: 0 } });
        }
        return jsonResponse({ result: { stdout: "", exit_code: 0 } });
      }
      if (url.pathname.endsWith("/files")) return new Response(new TextEncoder().encode("notes"));
      return jsonResponse({});
    }) as typeof fetch;
    const files: PortableFile[] = [];
    for await (const file of new CreateOSSandboxProvider({
      apiKey: "test-key",
      fetch: fetchImpl,
    }).exportWorkspace(computer, context)) {
      files.push(file);
    }
    expect(files.map((file) => file.path)).toEqual(["notes.txt"]);
  });
});

describe("CreateOS screen URL hosts", () => {
  const base = "https://api.sb.createos.sh";

  it.each([
    "https://api.sb.createos.sh/vnc.html",
    "https://sandbox.app.sb.createos.sh/vnc.html?token=t",
    "https://novnc.api.sb.createos.sh/vnc.html",
  ])("allows %s", (value) => {
    expect(isAllowedCreateOSScreenUrl(new URL(value), base)).toBe(true);
  });

  it.each([
    "https://evil.example/vnc.html",
    "https://api.sb.createos.sh.evil.example/vnc.html",
    "https://sandbox.app.sb.createos.sh:8443/vnc.html",
    "http://api.sb.createos.sh/vnc.html",
    "https://user:pass@sandbox.app.sb.createos.sh/vnc.html",
  ])("rejects %s", (value) => {
    expect(isAllowedCreateOSScreenUrl(new URL(value), base)).toBe(false);
  });

  it("keeps a custom base on that host and its subdomains", () => {
    const custom = "https://sandbox.example.test";
    expect(
      isAllowedCreateOSScreenUrl(new URL("https://sandbox.example.test/vnc.html"), custom),
    ).toBe(true);
    expect(
      isAllowedCreateOSScreenUrl(new URL("https://novnc.sandbox.example.test/vnc.html"), custom),
    ).toBe(true);
    expect(isAllowedCreateOSScreenUrl(new URL("https://other.example.test/vnc.html"), custom)).toBe(
      false,
    );
    expect(
      isAllowedCreateOSScreenUrl(new URL("https://sandbox.app.sb.createos.sh/vnc.html"), custom),
    ).toBe(false);
  });

  it("allows loopback http only for a loopback base", () => {
    expect(
      isAllowedCreateOSScreenUrl(
        new URL("http://127.0.0.1:8080/vnc.html"),
        "http://127.0.0.1:8080",
      ),
    ).toBe(true);
    expect(isAllowedCreateOSScreenUrl(new URL("http://127.0.0.1:8080/vnc.html"), base)).toBe(false);
  });
});

describe("CreateOS screen map", () => {
  async function mapOp(dir: string, op: string, key: string, screen: string) {
    const { stdout } = await execFileAsync("python3", [
      "-c",
      CREATEOS_SCREEN_MAP_SCRIPT,
      CREATEOS_SCREEN_MAP_SENTINEL,
      op,
      key,
      screen,
      path.join(dir, "screens.json"),
    ]);
    return stdout.trim();
  }

  it("gives two sessions distinct screens when they claim the primary together", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "createos-map-"));
    const [first, second] = await Promise.all([
      mapOp(dir, "put", "bot-a", "screen-0"),
      mapOp(dir, "put", "bot-b", "screen-0"),
    ]);
    expect([first, second].sort()).toEqual(["NEED_CREATE", "screen-0"]);
    const stored = JSON.parse(await mapOp(dir, "read", "", "")) as Record<string, string>;
    expect(Object.values(stored).filter((id) => id === "screen-0")).toHaveLength(1);
  });
});
