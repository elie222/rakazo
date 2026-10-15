/** Real pinned Codex auth against a loopback fake issuer; opt-in, no external credentials or login. */
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentRunRequest, AgentRuntimeEvent, ProcessEvent } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { CODEX_AUTH_SANDBOX_RUNNER } from "./primary-harness-auth-codex.js";
import { CODEX_SANDBOX_RUNNER, runCodexProtocol } from "./primary-harness-codex.js";
import { NativeEventQueue, NativeJsonlChannel } from "./primary-harness-protocol.js";

const modules = process.env.RAKAZO_NATIVE_HARNESS_TEST_MODULES;
const fakeAccess = "fake-native-access-token-private";
const fakeRefresh = "fake-native-refresh-token-private";
function jwt() {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ email: "owner@example.invalid", exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "fake-account", chatgpt_plan_type: "plus", user_id: "fake-user" } })}.fake`;
}

describe.skipIf(!modules)("actual Codex native login against a local fake issuer", () => {
  it("persists native managed credentials privately, reads them after restart, and logs out", async () => {
    const root = await mkdtemp(join(tmpdir(), "rakazo-codex-native-auth-"));
    const credentials = join(root, "credentials");
    await mkdir(credentials, { mode: 0o700 });
    let approved = false;
    let completions = 0;
    const completionBodies: Record<string, unknown>[] = [];
    const requests: string[] = [];
    const key = join(root, "test-key.pem"),
      cert = join(root, "test-ca.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
      ],
      { stdio: "ignore" },
    );
    const serverKey = join(root, "server-key.pem"),
      serverCsr = join(root, "server.csr"),
      serverCert = join(root, "server.pem"),
      extension = join(root, "server.ext");
    await writeFile(
      extension,
      "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n",
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        serverKey,
        "-out",
        serverCsr,
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "ignore" },
    );
    execFileSync(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        serverCsr,
        "-CA",
        cert,
        "-CAkey",
        key,
        "-CAcreateserial",
        "-out",
        serverCert,
        "-days",
        "1",
        "-extfile",
        extension,
      ],
      { stdio: "ignore" },
    );
    function respond(input: Record<string, unknown>, send: (event: unknown) => void) {
      if (input.generate === false) {
        send({
          type: "response.completed",
          response: {
            id: "prewarm",
            object: "response",
            status: "completed",
            output: [],
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          },
        });
        return;
      }
      expect(input.tools).toEqual([expect.objectContaining({ type: "namespace", name: "rakazo" })]);
      completionBodies.push(input);
      completions++;
      const response = {
        id: `resp_${completions}`,
        object: "response",
        created_at: 1,
        model: "gpt-5.4",
      };
      send({
        type: "response.created",
        response: { ...response, status: "in_progress", output: [] },
      });
      const item =
        completions % 2
          ? {
              id: `item_${completions}`,
              type: "function_call",
              call_id: `call_${completions}`,
              namespace: "rakazo",
              name: "read_file",
              arguments: '{"path":"note.md"}',
            }
          : {
              id: `item_${completions}`,
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Native account verified." }],
            };
      send({ type: "response.output_item.done", item });
      send({
        type: "response.completed",
        response: {
          ...response,
          status: "completed",
          output: [item],
          usage: {
            input_tokens: 20,
            output_tokens: 8,
            total_tokens: 28,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      });
    }
    const backend = createSecureServer(
      { key: await readFile(serverKey), cert: await readFile(serverCert) },
      async (req, res) => {
        requests.push(req.url ?? "");
        let body = "";
        for await (const data of req) body += data;
        if (req.url?.endsWith("/responses")) {
          expect(req.headers.authorization).toBe(`Bearer ${fakeAccess}`);
          res.setHeader("content-type", "text/event-stream");
          respond(JSON.parse(body), (event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
          res.end();
        } else {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ models: [] }));
        }
      },
    );
    const sockets = new WebSocketServer({ server: backend });
    sockets.on("connection", (socket, req) => {
      expect(req.headers.authorization).toBe(`Bearer ${fakeAccess}`);
      socket.on("message", (bytes) =>
        respond(JSON.parse(String(bytes)), (event) => socket.send(JSON.stringify(event))),
      );
    });
    backend.listen(0, "127.0.0.1");
    await once(backend, "listening");
    const backendAddress = backend.address();
    if (!backendAddress || typeof backendAddress === "string")
      throw new Error("Missing TLS test port");
    const backendOrigin = `https://127.0.0.1:${backendAddress.port}`;
    const server = createServer(async (req, res) => {
      requests.push(req.url ?? "");
      for await (const _ of req) {
      }
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/accounts/deviceauth/usercode")
        res.end(
          JSON.stringify({ device_auth_id: "fake-device", user_code: "FAKE-CODE", interval: "1" }),
        );
      else if (req.url === "/api/accounts/deviceauth/token") {
        if (!approved) {
          res.writeHead(403);
          res.end("{}");
        } else
          res.end(
            JSON.stringify({
              authorization_code: "fake-code",
              code_challenge: "fake-challenge",
              code_verifier: "fake-verifier",
            }),
          );
      } else if (req.url === "/oauth/token")
        res.end(
          JSON.stringify({
            access_token: fakeAccess,
            refresh_token: fakeRefresh,
            id_token: jwt(),
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
      else if (req.url === "/api/codex/accounts/check")
        res.end(
          JSON.stringify({
            accounts: [
              {
                id: "fake-account",
                plan_type: "plus",
                workspace_backend_origin: backendOrigin,
                account_routing_override: "NO_CONSTRAINT",
                structure: "personal",
              },
            ],
            account_ordering: ["fake-account"],
            default_account_id: "fake-account",
          }),
        );
      else {
        res.writeHead(404);
        res.end("{}");
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    const issuer = `http://127.0.0.1:${address.port}`;
    const stop: Array<() => Promise<void>> = [];
    async function runner(timeoutMs = 600000) {
      const home = await mkdtemp(join(root, "home-"));
      const source = CODEX_AUTH_SANDBOX_RUNNER.replaceAll("600000", String(timeoutMs))
        .replaceAll("/opt/rakazo-harness/node_modules", modules!)
        .replaceAll("/credentials/codex", credentials)
        .replaceAll("/home/harness", home)
        // Test-only transport substitution: production accepts only the official HTTPS issuer.
        .replace(
          "url.protocol!=='https:'||url.hostname!=='auth.openai.com'",
          "url.protocol!=='http:'||url.hostname!=='127.0.0.1'",
        )
        .replace(
          "'-c','cli_auth_credentials_store=\"file\"'",
          `'-c',${JSON.stringify(`chatgpt_base_url=${JSON.stringify(issuer)}`)},'-c','cli_auth_credentials_store="file"'`,
        );
      const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: home,
          CODEX_APP_SERVER_LOGIN_ISSUER: issuer,
          OPENAI_BASE_URL: issuer,
          HTTP_PROXY: issuer,
          HTTPS_PROXY: issuer,
          ALL_PROXY: issuer,
          NO_PROXY: "127.0.0.1",
          CODEX_CA_CERTIFICATE: cert,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const frames: Record<string, unknown>[] = [];
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (data) => {
        stdout += String(data);
      });
      child.stderr.on("data", (data) => {
        stderr += String(data);
      });
      createInterface({ input: child.stdout }).on("line", (line) => frames.push(JSON.parse(line)));
      const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
      const close = async () => {
        child.stdin.end();
        const timeout = setTimeout(() => child.kill("SIGKILL"), 2000);
        await exited;
        clearTimeout(timeout);
      };
      stop.push(close);
      async function frame(test: (m: Record<string, unknown>) => boolean) {
        const until = Date.now() + 15000;
        while (Date.now() < until) {
          const index = frames.findIndex(test);
          if (index >= 0) return frames.splice(index, 1)[0]!;
          if (child.exitCode !== null) throw new Error(`Native runner stopped: ${stderr}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Native response timed out: ${stderr}; ${stdout}`);
      }
      let seq = 0;
      return {
        close,
        stdout: () => stdout,
        stderr: () => stderr,
        frame,
        request: async (method: string) => {
          const id = String(++seq);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: {} })}\n`);
          return (await frame((m) => m.id === id)).result;
        },
      };
    }
    try {
      const first = await runner();
      expect(await first.request("rakazo/auth/start")).toMatchObject({
        state: "pending",
        verificationUri: `${issuer}/codex/device`,
        userCode: "FAKE-CODE",
      });
      approved = true;
      expect(
        (await first.frame((m) => m.method === "rakazo/auth/state")).params,
        first.stderr() + JSON.stringify(requests),
      ).toEqual({
        state: "ready",
        accountLabel: "owner@example.invalid",
        plan: "plus",
      });
      expect(first.stdout() + first.stderr()).not.toContain(fakeAccess);
      expect(first.stdout() + first.stderr()).not.toContain(fakeRefresh);
      await first.close();
      const saved = await readFile(join(credentials, "auth.json"), "utf8");
      expect(saved).toContain(fakeAccess);
      expect(saved).toContain(fakeRefresh);
      expect(await readdir(credentials)).toEqual(["auth.json"]);
      const sessions = join(root, "sessions");
      await mkdir(sessions, { mode: 0o700 });
      let nativeSessionId: string | undefined;
      let usageState: Record<string, unknown> | undefined;
      let mediated = 0;
      for (let turn = 0; turn < 2; turn++) {
        const home = await mkdtemp(join(root, "runtime-home-"));
        const source = CODEX_SANDBOX_RUNNER.replaceAll("/opt/rakazo-harness/node_modules", modules!)
          .replaceAll("/credentials/codex", credentials)
          .replaceAll("/home/harness", home)
          .replaceAll("/sessions/", `${sessions}/`);
        const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
          cwd: home,
          detached: true,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            TMPDIR: home,
            HTTP_PROXY: issuer,
            HTTPS_PROXY: issuer,
            ALL_PROXY: issuer,
            NO_PROXY: "127.0.0.1",
            CODEX_CA_CERTIFICATE: cert,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        const events = new NativeEventQueue<ProcessEvent>();
        let diagnostics = "";
        child.stdout.on("data", (data) => events.push({ type: "stdout", data: String(data) }));
        child.stderr.on("data", (data) => {
          diagnostics = (diagnostics + String(data)).slice(-2048);
        });
        child.on("exit", (code) => {
          events.push({ type: "exit", code: code ?? 1 });
          events.end();
        });
        const channel = new NativeJsonlChannel(
          {
            events,
            writeStdin: async (data) => {
              child.stdin.write(data);
            },
            closeStdin: async () => {
              child.stdin.end();
            },
            terminate: async () => {
              events.end();
              try {
                if (child.pid) process.kill(-child.pid, "SIGKILL");
              } catch {}
            },
          },
          AbortSignal.timeout(30000),
        );
        const requestRpc = channel.request.bind(channel);
        channel.request = (method, params) =>
          requestRpc(
            method,
            method === "rakazo/start"
              ? {
                  ...params,
                  config: {
                    ...(params.config as Record<string, unknown>),
                    chatgpt_base_url: issuer,
                    sqlite_home: join(sessions, "codex-state"),
                  },
                }
              : params,
          );
        const tool = {
          name: "read_file",
          description: "Read authorized note",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        };
        const request: AgentRunRequest = {
          runId: `turn-${turn}`,
          botId: "bot",
          threadId: "thread",
          history: [],
          prompt: "Read note.md",
          instructions: "Use only the authorized read_file tool.",
          tools: [tool],
          model: {
            id: "gpt-5.4",
            provider: "native-codex",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            nativeLogin: {
              kind: "native_login",
              harness: "codex",
              installationId: "a".repeat(32),
              connectionId: "11111111-1111-4111-8111-111111111111",
              epoch: "22222222-2222-4222-8222-222222222222",
              computerId: "db-computer",
              computerProviderRef: "private-container",
              computerHomeKey: "bot",
              spaceId: "space",
              region: "global",
              state: "ready",
            },
          },
        };
        const output: AgentRuntimeEvent[] = [];
        const previous = nativeSessionId;
        try {
          await runCodexProtocol(channel, {
            request,
            tools: [tool],
            prompt: request.prompt,
            nativeSessionId,
            usageState,
            onUsageState: (state) => {
              usageState = state;
            },
            signal: new AbortController().signal,
            emit: (event) => output.push(event),
            setInterrupt: () => {},
            onSession: (id) => {
              nativeSessionId = id;
            },
            callTool: async (name, args) => {
              expect(name).toBe("read_file");
              expect(args).toEqual({ path: "note.md" });
              mediated++;
              return { text: "The note is blue.", isError: false };
            },
          });
        } catch (error) {
          throw new Error(
            `${String(error)}: ${diagnostics}; requests: ${JSON.stringify(requests)}`,
          );
        } finally {
          await channel.close();
        }
        expect(
          output.some(
            (event) => event.type === "text" && event.text === "Native account verified.",
          ),
        ).toBe(true);
        if (previous) expect(nativeSessionId).toBe(previous);
      }
      expect(mediated).toBe(2);
      expect(completionBodies).toHaveLength(4);
      const resumed = await runner();
      expect(await resumed.request("rakazo/auth/status")).toEqual({
        state: "ready",
        accountLabel: "owner@example.invalid",
        plan: "plus",
      });
      await resumed.request("rakazo/auth/logout");
      expect(await resumed.request("rakazo/auth/status")).toEqual({ state: "signed_out" });
      expect(resumed.stdout() + resumed.stderr()).not.toContain(fakeAccess);
      expect(requests).toContain("/oauth/token");
      await resumed.close();
      approved = false;
      const cancelled = await runner();
      expect(await cancelled.request("rakazo/auth/start")).toMatchObject({ state: "pending" });
      expect(await cancelled.request("rakazo/auth/cancel")).toEqual({
        state: "failed",
        code: "cancelled",
      });
      expect((await cancelled.frame((m) => m.method === "rakazo/auth/state")).params).toEqual({
        state: "failed",
        code: "cancelled",
      });
      await cancelled.close();
      const expired = await runner(50);
      expect(await expired.request("rakazo/auth/start")).toMatchObject({ state: "pending" });
      expect((await expired.frame((m) => m.method === "rakazo/auth/state")).params).toEqual({
        state: "failed",
        code: "expired",
      });
      await expired.close();
      expect(await readdir(credentials)).toEqual([]);
    } finally {
      await Promise.all(stop.map((fn) => fn()));
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      backend.closeAllConnections();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
