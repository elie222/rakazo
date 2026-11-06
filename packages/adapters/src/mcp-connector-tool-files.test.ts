import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorEvent } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeToolFileStore } from "./fake-tool-files.js";
import { McpConnector } from "./mcp-connector.js";
import { mcpPackageDir } from "./mcp-package-installer.js";
import { LOCAL_FILE_PATH_UNSUPPORTED } from "./tool-file-args.js";

/**
 * A dependency-free stdio MCP server shaped like Gmail MCP: `download` saves an attachment in
 * its download folder and names the saved path, `attach` reads attachment paths (which must be
 * inside its attachment folder), `env` reports how it was launched, `image` returns an image.
 */
const SERVER_SOURCE = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const text = (value) => ({ content: [{ type: "text", text: value }] });
const tools = ["env", "download", "attach", "image"].map((name) => ({ name, inputSchema: { type: "object" } }));
function call(name, args) {
  const env = process.env;
  if (name === "env")
    return text(JSON.stringify({
      cwd: process.cwd(),
      HOME: env.HOME,
      TMPDIR: env.TMPDIR,
      RAKAZO_OUTPUT_DIR: env.RAKAZO_OUTPUT_DIR,
      RAKAZO_INPUT_DIR: env.RAKAZO_INPUT_DIR,
      GMAIL_MCP_DOWNLOAD_DIR: env.GMAIL_MCP_DOWNLOAD_DIR,
      GMAIL_MCP_ATTACHMENT_DIR: env.GMAIL_MCP_ATTACHMENT_DIR,
      FILES_OUT_DIR: env.FILES_OUT_DIR,
    }));
  if (name === "download") {
    const dir = env.GMAIL_MCP_DOWNLOAD_DIR || env.FILES_OUT_DIR || env.RAKAZO_OUTPUT_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const saved = path.join(dir, "invoice.pdf");
    fs.writeFileSync(saved, "%PDF-from-gmail");
    fs.writeFileSync(path.join(env.RAKAZO_OUTPUT_DIR, "unnamed.pdf"), "%PDF-other-call");
    return text("Attachment downloaded to " + saved + "." + (args.extra ? " See also " + args.extra : ""));
  }
  if (name === "attach") {
    const jail = env.GMAIL_MCP_ATTACHMENT_DIR + path.sep;
    const lines = (args.attachments || []).map((file) => {
      if (!path.isAbsolute(file) || !fs.realpathSync(file).startsWith(fs.realpathSync(jail)))
        throw new Error("Attachment path must be absolute and inside " + jail);
      return "attached " + file + " (" + fs.readFileSync(file, "utf8") + ")";
    });
    if (args.fail === "result")
      return { isError: true, content: [{ type: "text", text: "send failed for " + args.attachments.join(", ") }] };
    if (args.fail) throw new Error("send failed for " + args.attachments.join(", "));
    return text(lines.join("\\n"));
  }
  if (name === "image")
    return { content: [{ type: "image", data: Buffer.from("PNGDATA").toString("base64"), mimeType: "image/png" }] };
  throw new Error("unknown tool");
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (message.id === undefined) continue;
    if (message.method === "initialize")
      send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "files", version: "1" } } });
    else if (message.method === "tools/list") send({ id: message.id, result: { tools } });
    else if (message.method === "tools/call") {
      try {
        send({ id: message.id, result: call(message.params.name, message.params.arguments || {}) });
      } catch (error) {
        send({ id: message.id, error: { code: -32603, message: error.message } });
      }
    } else send({ id: message.id, result: {} });
  }
});
`;

const GMAIL_SPEC = "@klodr/gmail-mcp@1.0.0";
const OTHER_SPEC = "@demo/files-mcp@1.0.0";
const SCOPE = { spaceId: "w1", userId: "u1", botId: "bot-1" };

/** What a finished install leaves behind, without running npm. */
async function publishPackage(root: string, spec: string): Promise<void> {
  const name = spec.slice(0, spec.lastIndexOf("@"));
  const dir = mcpPackageDir(spec, root);
  const packageDir = join(dir, "node_modules", ...name.split("/"));
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", bin: { files: "server.js" } }),
  );
  await writeFile(join(packageDir, "server.js"), SERVER_SOURCE);
  await chmod(join(packageDir, "server.js"), 0o755);
  await writeFile(join(dir, ".ready"), "{}\n");
}

function serverFor(spec: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "server-1",
    slug: "gmail",
    name: "Gmail",
    transport: "stdio",
    command: "npx",
    args: ["-y", spec],
    endpoint: null,
    secretId: "secret-1",
    enabled: true,
    revision: 1,
    ...overrides,
  };
}

function contextFor() {
  return {
    operationId: "test",
    traceId: "test",
    ...SCOPE,
    runId: "run-1",
    signal: new AbortController().signal,
  } as never;
}

describe("MCP connector temporary tool files", () => {
  let root: string;
  let packages: string;
  let workspaces: string;
  let store: FakeToolFileStore;
  const connectors: McpConnector[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rakazo-mcp-tool-files-"));
    packages = join(root, "packages");
    workspaces = join(root, "workspaces");
    await mkdir(workspaces);
    await publishPackage(packages, GMAIL_SPEC);
    await publishPackage(packages, OTHER_SPEC);
    store = new FakeToolFileStore();
  });

  afterEach(async () => {
    await Promise.all(connectors.splice(0).map((connector) => connector.close()));
    await rm(root, { recursive: true, force: true });
  });

  function connectorFor(
    server: ReturnType<typeof serverFor>,
    options: { env?: Record<string, string>; toolFiles?: FakeToolFileStore | null } = {},
  ) {
    const assignment = {
      botId: "bot-1",
      serverId: server.id,
      spaceId: "w1",
      userId: "u1",
      allowAllTools: true,
      allowedTools: [],
      server,
    };
    const prisma = {
      botMcpServer: { findMany: async () => [assignment], findFirst: async () => assignment },
      secret: { findFirst: async () => ({ id: "secret-1", ciphertext: "cipher" }) },
      mcpServer: {
        findMany: async () => [],
        findFirst: async () => null,
        updateMany: async () => ({ count: 1 }),
      },
    };
    const secrets = { load: async () => JSON.stringify({ env: options.env ?? {} }) };
    const connector = new McpConnector(prisma as never, secrets as never, {
      stdioEnabled: true,
      allowedCommands: ["npx"],
      packagesDir: packages,
      credentialTempRoot: workspaces,
      toolFiles: options.toolFiles === null ? undefined : (options.toolFiles ?? store),
    });
    connectors.push(connector);
    return connector;
  }

  async function call(
    connector: McpConnector,
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<ConnectorEvent[]> {
    const events: ConnectorEvent[] = [];
    for await (const event of connector.execute(
      {
        tool: `mcp__gmail__${tool}`,
        args,
        executionId: `call-${tool}`,
        route: { connectorId: "mcp", resourceId: "server-1", resourceRevision: 1, toolName: tool },
      },
      contextFor(),
    ))
      events.push(event);
    return events;
  }

  const resultText = (events: ConnectorEvent[]) => {
    const [event] = events;
    if (event?.type !== "result")
      throw new Error(`expected a result, got ${JSON.stringify(event)}`);
    return (event.data as { content: Array<{ text: string }> }).content[0]!.text;
  };

  async function launchEnv(connector: McpConnector) {
    return JSON.parse(resultText(await call(connector, "env"))) as Record<string, string>;
  }

  it("runs every stdio process in a private workspace removed when it stops", async () => {
    const connector = connectorFor(serverFor(OTHER_SPEC));
    const env = await launchEnv(connector);
    const [workspace] = await readdir(workspaces);
    const dir = join(workspaces, workspace!);
    expect(env).toMatchObject({
      cwd: dir,
      TMPDIR: join(dir, "tmp"),
      RAKAZO_OUTPUT_DIR: join(dir, "out"),
      RAKAZO_INPUT_DIR: join(dir, "in"),
      HOME: process.env.HOME,
    });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await readdir(dir)).sort()).toEqual(["in", "out", "tmp"]);
    await connector.close();
    expect(await readdir(workspaces)).toEqual([]);
  });

  it("points a known package's folders at the workspace over the user's own values", async () => {
    const connector = connectorFor(serverFor(GMAIL_SPEC), {
      env: { GMAIL_MCP_DOWNLOAD_DIR: "/tmp/gmail-mcp/downloads", GMAIL_MCP_ATTACHMENT_DIR: "/x" },
    });
    const env = await launchEnv(connector);
    expect(env.GMAIL_MCP_DOWNLOAD_DIR).toBe(env.RAKAZO_OUTPUT_DIR);
    expect(env.GMAIL_MCP_ATTACHMENT_DIR).toBe(env.RAKAZO_INPUT_DIR);
  });

  it("points a server's configured output variable at the workspace", async () => {
    const connector = connectorFor(serverFor(OTHER_SPEC, { outputEnv: "FILES_OUT_DIR" }), {
      env: { FILES_OUT_DIR: "/somewhere/else" },
    });
    const env = await launchEnv(connector);
    expect(env.FILES_OUT_DIR).toBe(env.RAKAZO_OUTPUT_DIR);
    expect(env.GMAIL_MCP_DOWNLOAD_DIR).toBeUndefined();
  });

  it("turns a saved file the result names into a temporary file, and nothing else", async () => {
    const outside = join(root, "outside.pdf");
    await writeFile(outside, "%PDF-outside");
    const connector = connectorFor(serverFor(GMAIL_SPEC), {
      env: { GMAIL_MCP_DOWNLOAD_DIR: "/tmp/gmail-mcp/downloads" },
    });
    const env = await launchEnv(connector);
    const text = resultText(await call(connector, "download", { extra: outside }));
    const [file] = [...store.files.values()];
    expect(file).toMatchObject({
      name: "invoice.pdf",
      mimeType: "application/pdf",
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      runId: "run-1",
    });
    expect(Buffer.from(file!.bytes).toString()).toBe("%PDF-from-gmail");
    expect(text).toContain(`{{file:${file!.id}}}`);
    expect(text).not.toContain(env.RAKAZO_OUTPUT_DIR!);
    // A path outside the workspace stays as written and its file untouched.
    expect(text).toContain(`See also ${outside}`);
    expect(await readFile(outside, "utf8")).toBe("%PDF-outside");
    // Imported files leave the disk; files the result did not name stay for their owner.
    expect(await readdir(env.RAKAZO_OUTPUT_DIR!)).toEqual(["unnamed.pdf"]);
  });

  it("keeps images out of the result", async () => {
    const connector = connectorFor(serverFor(OTHER_SPEC));
    const text = resultText(await call(connector, "image"));
    const [file] = [...store.files.values()];
    expect(file).toMatchObject({ name: "image-1.png", mimeType: "image/png" });
    expect(text).toContain(`{{file:${file!.id}}}`);
  });

  it("passes results through unchanged without a store", async () => {
    const connector = connectorFor(serverFor(GMAIL_SPEC), { toolFiles: null });
    const env = await launchEnv(connector);
    const text = resultText(await call(connector, "download"));
    expect(text).toContain(join(env.RAKAZO_OUTPUT_DIR!, "invoice.pdf"));
    expect((await readdir(env.RAKAZO_OUTPUT_DIR!)).sort()).toEqual(["invoice.pdf", "unnamed.pdf"]);
  });

  describe("file path placeholders", () => {
    async function invoice() {
      return store.create({
        ...SCOPE,
        name: "invoice.pdf",
        mimeType: "application/pdf",
        bytes: new TextEncoder().encode("%PDF-stored"),
      });
    }

    it("hands the server a private copy by its original name and deletes it after", async () => {
      const file = await invoice();
      const connector = connectorFor(serverFor(GMAIL_SPEC));
      const env = await launchEnv(connector);
      const text = resultText(
        await call(connector, "attach", { attachments: [`{{file_path:${file.id}}}`] }),
      );
      // The server read the copy inside its attachment folder, under the file's real name.
      expect(text).toBe(`attached {{file_path:${file.id}}} (%PDF-stored)`);
      expect(await readdir(env.RAKAZO_INPUT_DIR!)).toEqual([]);
    });

    it("deletes the copy when the tool reports a failure", async () => {
      const file = await invoice();
      const connector = connectorFor(serverFor(GMAIL_SPEC));
      const env = await launchEnv(connector);
      const text = resultText(
        await call(connector, "attach", {
          attachments: [`{{file_path:${file.id}}}`],
          fail: "result",
        }),
      );
      expect(text).toBe(`send failed for {{file_path:${file.id}}}`);
      expect(await readdir(env.RAKAZO_INPUT_DIR!)).toEqual([]);
    });

    it("keeps the copy's path out of a thrown error", async () => {
      const file = await invoice();
      const connector = connectorFor(serverFor(GMAIL_SPEC));
      const env = await launchEnv(connector);
      const events = await call(connector, "attach", {
        attachments: [`{{file_path:${file.id}}}`],
        fail: true,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error" });
      const message = (events[0] as { message: string }).message;
      expect(message).toContain(`send failed for {{file_path:${file.id}}}`);
      expect(message).not.toContain(env.RAKAZO_INPUT_DIR!);
      // A thrown call drops the process, and its workspace with it.
      await vi.waitFor(() => expect(stat(env.RAKAZO_INPUT_DIR!)).rejects.toThrow());
    });

    it("fails without calling the server for a file out of scope", async () => {
      const other = await store.create({
        ...SCOPE,
        botId: "bot-2",
        name: "other.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array([1]),
      });
      const connector = connectorFor(serverFor(GMAIL_SPEC));
      expect(
        await call(connector, "attach", { attachments: [`{{file_path:${other.id}}}`] }),
      ).toEqual([
        {
          type: "error",
          message: `File {{file_path:${other.id}}} is not available (it may have expired)`,
        },
      ]);
    });

    it("refuses a file path for a remote server before connecting", async () => {
      const file = await invoice();
      const connector = connectorFor(
        serverFor(GMAIL_SPEC, {
          transport: "streamable-http",
          command: null,
          args: [],
          endpoint: "https://mcp.example.test/mcp",
        }),
      );
      expect(
        await call(connector, "attach", { attachments: [`{{file_path:${file.id}}}`] }),
      ).toEqual([{ type: "error", message: LOCAL_FILE_PATH_UNSUPPORTED }]);
    });
  });
});
