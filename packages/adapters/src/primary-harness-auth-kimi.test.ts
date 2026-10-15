import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  ProcessEvent,
  SandboxProcessHandle,
} from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KIMI_AUTH_SANDBOX_RUNNER } from "./primary-harness-auth-kimi.js";
import { buildKimiProcess, runKimiProtocol } from "./primary-harness-kimi.js";
import { NativeEventQueue, NativeJsonlChannel } from "./primary-harness-protocol.js";

const FAKE_TOKEN = "fake_private_native_token_never_emit_123456789";
const fixture = `
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
const home=process.env.KIMI_CODE_HOME;
const scenario=JSON.parse(readFileSync(new URL('../scenario.json',import.meta.url),'utf8'));
const token='${FAKE_TOKEN}';
const secret=home+'/credentials/fixture.json';
let flow=null,polls=0;
mkdirSync(home+'/server/instances',{recursive:true,mode:0o700});
writeFileSync(home+'/server.token',token,{mode:0o600});
writeFileSync(home+'/device_id','fake-native-device-uuid',{mode:0o600});
const server=createServer(async(req,res)=>{
 if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end();return;}
 let body='';for await(const chunk of req)body+=chunk;
 const send=data=>res.end(JSON.stringify({code:0,data,request_id:'private-request-id'}));
 if(req.url==='/api/v1/auth')return send({managed_provider:{name:'managed:kimi-code',status:existsSync(secret)?'authenticated':'unauthenticated'}});
 if(req.url.startsWith('/api/v1/oauth/userinfo'))return send({kind:'ok',userInfo:{email:'fixture@example.invalid',userLevelName:'Fixture plan',phone:'private-phone',token}});
 if(req.url==='/api/v1/oauth/login'&&req.method==='POST'){
  if(JSON.parse(body).region!=='global')throw new Error('Unexpected region');
  if(scenario.error){res.writeHead(503);res.end(token);return;}
  flow={provider:'managed:kimi-code',flow_id:'flow_fixture',status:'pending',verification_uri:scenario.uri??'https://auth.kimi.ai/device',verification_uri_complete:'https://auth.kimi.ai/device?secret='+token,user_code:'ABCD-EFGH',expires_at:new Date(Date.now()+900000).toISOString()};
  return send(flow);
 }
 if(req.url.startsWith('/api/v1/oauth/login')&&req.method==='GET'){
  if(flow&&scenario.finish&&++polls>=1){flow.status=scenario.finish;if(flow.status==='authenticated')writeFileSync(secret,JSON.stringify({token}),{mode:0o600});}
  return send(flow);
 }
 if(req.url.startsWith('/api/v1/oauth/login')&&req.method==='DELETE'){if(flow)flow.status='cancelled';return send({cancelled:true,status:'cancelled'});}
 if(req.url==='/api/v1/oauth/logout'){if(existsSync(secret))unlinkSync(secret);return send({logged_out:true,provider:'managed:kimi-code'});}
 res.writeHead(404);res.end(token);
});
server.listen(0,'127.0.0.1',()=>{
 writeFileSync(home+'/server/instances/fake.json',JSON.stringify({pid:process.pid,host:'127.0.0.1',port:server.address().port}),{mode:0o600});
 console.log('Kimi server: http://127.0.0.1:'+server.address().port+'/#token='+token);
 console.error('Native diagnostic '+token);
});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`;

type Frame = { id?: string; method?: string; result?: unknown; params?: unknown; error?: unknown };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

async function harness(
  scenario: Record<string, unknown> = {},
  native?: { packagePath: string; issuer: string },
  existingCredentials?: string,
) {
  const root = await mkdtemp(join(tmpdir(), "rakazo-kimi-auth-test-"));
  const pkg = join(root, "package");
  const credentials = existingCredentials ?? join(root, "credentials");
  const temporary = join(root, "temporary");
  await mkdir(join(pkg, "dist"), { recursive: true });
  await mkdir(temporary);
  await writeFile(join(pkg, "package.json"), JSON.stringify({ version: "2.2.0" }));
  await writeFile(join(pkg, "scenario.json"), JSON.stringify(scenario));
  await writeFile(join(pkg, "dist", "main.mjs"), fixture);
  let source = KIMI_AUTH_SANDBOX_RUNNER.replace(
    "'/opt/rakazo-harness/node_modules/@moonshot-ai/kimi-code'",
    JSON.stringify(native?.packagePath ?? pkg),
  ).replace("'/credentials/kimi'", JSON.stringify(credentials));
  let guardPath: string | undefined;
  if (native) {
    // Test-only transport interception: the official CLI and production config
    // stay unchanged. Every public request is rejected before any DNS/network.
    guardPath = join(root, "offline-guard.mjs");
    await writeFile(
      guardPath,
      `import net from 'node:net';
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 const first=Array.isArray(args[0])?args[0][0]:args[0];
 const host=typeof first==='object'?first.host:typeof args[1]==='string'?args[1]:undefined;
 if(host!==undefined&&!['127.0.0.1','::1','localhost'].includes(host))throw new Error('Public network disabled');
 return connect.apply(this,args);
};
const original=globalThis.fetch;
globalThis.fetch=(input,init)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 if(['auth.kimi.ai','api.kimi.ai'].includes(url.hostname))return original(${JSON.stringify(native.issuer)}+url.pathname+url.search,{...init,redirect:'error'});
 if(url.hostname==='127.0.0.1')return original(input,{...init,redirect:'error'});
 throw new Error('Public network disabled');
};`,
    );
    source = source.replace(
      "child=spawn(process.execPath,[root+'/dist/main.mjs'",
      `child=spawn(process.execPath,['--import',${JSON.stringify(guardPath)},root+'/dist/main.mjs'`,
    );
  }
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    env: { PATH: process.env.PATH, TMPDIR: temporary },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  const frames: Frame[] = [];
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => frames.push(JSON.parse(line)));
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const close = async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 2500);
    await exited;
    clearTimeout(timer);
  };
  cleanup.push(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });
  async function frame(match: (value: Frame) => boolean): Promise<Frame> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const index = frames.findIndex(match);
      if (index >= 0) return frames.splice(index, 1)[0]!;
      if (child.exitCode !== null) throw new Error(`Fixture stopped: ${errors}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Fixture response timed out: ${errors}`);
  }
  let seq = 0;
  return {
    credentials,
    guardPath,
    close,
    send: (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`),
    raw: (value: string) => child.stdin.write(value),
    frame,
    output: () => output,
    errors: () => errors,
    exited,
    async request(method: string, params: unknown = {}) {
      const id = String(++seq);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return frame((value) => value.id === id);
    },
  };
}

describe("Kimi isolated native authentication", () => {
  it("returns bounded native device flow and sanitized completion without exposing secrets", async () => {
    const run = await harness({ finish: "authenticated" });
    const started = await run.request("rakazo/auth/start", { region: "global" });
    expect(started.result).toMatchObject({
      state: "pending",
      verificationUri: "https://auth.kimi.ai/device",
      userCode: "ABCD-EFGH",
    });
    const completed = await run.frame((value) => value.method === "rakazo/auth/state");
    expect(completed.params).toEqual({
      state: "ready",
      accountLabel: "fixture@example.invalid",
      plan: "Fixture plan",
    });
    expect(run.output()).not.toContain(FAKE_TOKEN);
    expect(run.output()).not.toContain("private-phone");
    expect(run.errors()).toBe("");
    expect(await readFile(join(run.credentials, "device_id"), "utf8")).toBe(
      "fake-native-device-uuid",
    );
    expect((await run.request("rakazo/auth/logout")).result).toEqual({ state: "signed_out" });
    expect((await run.request("rakazo/auth/status")).result).toEqual({ state: "signed_out" });
  });

  it("cancels the native pending flow and reports only the static state", async () => {
    const run = await harness();
    await run.request("rakazo/auth/start");
    expect((await run.request("rakazo/auth/cancel")).result).toEqual({
      state: "failed",
      code: "cancelled",
    });
    expect((await run.frame((value) => value.method === "rakazo/auth/state")).params).toEqual({
      state: "failed",
      code: "cancelled",
    });
  });

  it.each(["denied", "expired"])("reports the native %s terminal", async (finish) => {
    const run = await harness({ finish });
    await run.request("rakazo/auth/start");
    expect((await run.frame((value) => value.method === "rakazo/auth/state")).params).toEqual({
      state: "failed",
      code: finish,
    });
  });

  it("rejects a region switch for an existing private connection", async () => {
    const run = await harness();
    await run.request("rakazo/auth/status", { region: "global" });
    expect((await run.request("rakazo/auth/start", { region: "mainland-cn" })).result).toEqual({
      state: "failed",
      code: "unavailable",
    });
  });

  it.each([
    "https://auth.kimi.ai.attacker.invalid/device",
    "http://auth.kimi.ai/device",
    "https://user:password@auth.kimi.ai/device",
    "https://auth.kimi.ai:8443/device",
    "https://auth.kimi.ai/device#fragment",
  ])("rejects nonofficial verification address %s", async (uri) => {
    const run = await harness({ uri });
    expect((await run.request("rakazo/auth/start")).result).toEqual({
      state: "failed",
      code: "unavailable",
    });
    expect(run.output()).not.toContain(uri);
  });

  it("fails closed for native error bodies, unknown operations and extra parameters", async () => {
    const run = await harness({ error: true });
    expect((await run.request("session/new")).error).toEqual({
      code: -32600,
      message: "Invalid authentication request",
    });
    expect(
      (await run.request("rakazo/auth/start", { endpoint: "https://example.invalid" })).result,
    ).toEqual({
      state: "failed",
      code: "unavailable",
    });
    expect((await run.request("rakazo/auth/start")).result).toEqual({
      state: "failed",
      code: "unavailable",
    });
    expect(run.output()).not.toContain(FAKE_TOKEN);
  });

  it("bounds unterminated input before JSON parsing", async () => {
    const run = await harness();
    run.raw("x".repeat(65537));
    await run.exited;
    expect(run.output()).toContain('"code":"unavailable"');
    expect(run.errors()).toBe("");
  });
});

function completion(index: number): string {
  const tool = index % 2 === 1;
  const chunk = (delta: unknown, finish: string | null, usage?: unknown) => ({
    id: `fixture-completion-${index}`,
    object: "chat.completion.chunk",
    created: 123,
    model: "kimi-fixture",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });
  const delta = tool
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "fixture_read",
            type: "function",
            function: { name: "mcp__rakazo__read_file", arguments: '{"path":"note.txt"}' },
          },
        ],
      }
    : {
        role: "assistant",
        content: index === 2 ? "Native read complete." : "Native resume complete.",
      };
  const frames = [
    chunk(delta, null),
    chunk({}, tool ? "tool_calls" : "stop", {
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
    }),
  ].map((value) => `data: ${JSON.stringify(value)}\n\n`);
  return `${frames.join("")}data: [DONE]\n\n`;
}

function nativeInferenceProcess(
  request: AgentRunRequest,
  home: string,
  sessions: string,
  credentials: string,
  guardPath: string,
) {
  const start = buildKimiProcess(request);
  expect(start.env).toEqual({});
  const source = start.argv[3]!.replaceAll("'/home/harness'", JSON.stringify(home))
    .replaceAll("'/sessions/kimi-code-sessions'", JSON.stringify(sessions))
    .replaceAll("'/credentials/kimi'", JSON.stringify(credentials))
    .replaceAll("/opt/rakazo-harness/node_modules", nativeModules!)
    .replace(
      "child=spawn(process.execPath,[root+'/dist/main.mjs'",
      `child=spawn(process.execPath,['--import',${JSON.stringify(guardPath)},root+'/dist/main.mjs'`,
    );
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: home,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      LANG: "C.UTF-8",
      KIMI_DISABLE_TELEMETRY: "1",
      KIMI_CODE_NO_AUTO_UPDATE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const events = new NativeEventQueue<ProcessEvent>();
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
    events.push({ type: "stdout", data: String(chunk) });
  });
  child.stderr.on("data", () => {});
  child.on("error", (error) => events.end(error));
  const exited = new Promise<void>((resolve) =>
    child.on("close", (code) => {
      events.push({ type: "exit", code: code ?? 1 });
      events.end();
      resolve();
    }),
  );
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {}
  };
  const handle: SandboxProcessHandle = {
    events,
    writeStdin: (data) =>
      new Promise((resolve, reject) => {
        child.stdin.write(data, (error) => (error ? reject(error) : resolve()));
      }),
    closeStdin: async () => {
      child.stdin.end();
    },
    terminate: async () => {
      kill("SIGTERM");
      const timer = setTimeout(() => kill("SIGKILL"), 1000);
      await exited;
      clearTimeout(timer);
    },
  };
  return { handle, output: () => output };
}

async function privateSessionContents(path: string): Promise<string> {
  const entries = await readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? privateSessionContents(join(path, entry.name))
          : entry.isFile()
            ? readFile(join(path, entry.name), "utf8")
            : Promise.resolve(""),
      ),
    )
  ).join("\n");
}

const nativeModules = process.env.RAKAZO_NATIVE_HARNESS_TEST_MODULES;
describe.skipIf(!nativeModules)("pinned Kimi 2.2 offline native login", () => {
  it("runs native device login, native refresh and native logout against a loopback issuer", async () => {
    let deviceRequests = 0;
    let refreshRequests = 0;
    const completions: Array<{
      messages: unknown[];
      tools: Array<{ function: { name: string } }>;
    }> = [];
    const failures: unknown[] = [];
    const paths: string[] = [];
    const server = createServer(async (req, res) => {
      paths.push(req.url ?? "");
      let body = "";
      for await (const chunk of req) body += String(chunk);
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/oauth/device_authorization") {
        deviceRequests++;
        res.end(
          JSON.stringify({
            user_code: "FAKE-CODE",
            device_code: "fake-device-credential",
            verification_uri: "https://auth.kimi.ai/device",
            verification_uri_complete: "https://auth.kimi.ai/device?user_code=FAKE-CODE",
            expires_in: 900,
            interval: 1,
          }),
        );
        return;
      }
      if (req.url === "/api/oauth/token") {
        const refreshing = new URLSearchParams(body).get("grant_type") === "refresh_token";
        if (refreshing) refreshRequests++;
        res.end(
          JSON.stringify({
            access_token: refreshing ? "fake-refreshed-access" : "fake-original-access",
            refresh_token: "fake-native-refresh",
            expires_in: refreshing ? 3600 : 30,
            token_type: "Bearer",
          }),
        );
        return;
      }
      if (req.url === "/coding/v1/models") {
        res.end(
          JSON.stringify({
            data: [
              {
                id: "kimi-fixture",
                context_length: 32768,
                supports_tool_use: true,
              },
            ],
          }),
        );
        return;
      }
      if (req.url === "/coding/v1/me") {
        res.end(
          JSON.stringify({
            user_id: "fake-account-id",
            email: "fixture@example.invalid",
            user_level_name: "Fixture plan",
          }),
        );
        return;
      }
      if (req.url === "/coding/v1/chat/completions") {
        try {
          expect(req.headers.authorization).toBe("Bearer fake-refreshed-access");
          const input = JSON.parse(body);
          expect(input.model).toBe("kimi-fixture");
          expect(
            input.tools.map((tool: { function: { name: string } }) => tool.function.name),
          ).toEqual(["mcp__rakazo__read_file"]);
          completions.push(input);
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(completion(completions.length));
        } catch (error) {
          failures.push(error);
          res.writeHead(500);
          res.end();
        }
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Unsupported fixture request" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const native = {
      packagePath: join(nativeModules!, "@moonshot-ai/kimi-code"),
      issuer: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    };
    const run = await harness({}, native);
    expect((await run.request("rakazo/auth/start")).result).toMatchObject({
      state: "pending",
      userCode: "FAKE-CODE",
    });
    expect((await run.frame((value) => value.method === "rakazo/auth/state")).params).toEqual({
      state: "ready",
      accountLabel: "fixture@example.invalid",
      plan: "Fixture plan",
    });
    expect(deviceRequests).toBe(1);
    expect(refreshRequests).toBeGreaterThan(0);
    expect(paths).toContain("/coding/v1/me");
    expect((await run.request("rakazo/auth/status")).result).toMatchObject({ state: "ready" });
    await run.close();
    const runtimeRoot = await mkdtemp(join(tmpdir(), "rakazo-kimi-native-runtime-"));
    cleanup.push(() => rm(runtimeRoot, { recursive: true, force: true }));
    const home = join(runtimeRoot, "home");
    const sessions = join(runtimeRoot, "sessions");
    await mkdir(home);
    await mkdir(sessions);
    const tool = {
      name: "read_file",
      description: "Read an authorized fixture file",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    };
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe("read_file");
      expect(args).toEqual({ path: "note.txt" });
      return { text: "fixture native file contents", isError: false };
    });
    let nativeSessionId: string | undefined;
    for (const resume of [false, true]) {
      const request: AgentRunRequest = {
        botId: "fixture-bot",
        threadId: "fixture-thread",
        runId: resume ? "fixture-resume" : "fixture-first",
        instructions: "Use only the authorized read_file tool.",
        prompt: resume ? "Read it again." : "Read note.txt.",
        history: [],
        tools: [tool],
        model: {
          provider: "kimi",
          id: "kimi-fixture",
          baseUrl: "https://api.kimi.ai/coding/v1",
          contextWindow: 32768,
          nativeLogin: {
            kind: "native_login",
            installationId: "a".repeat(32),
            harness: "kimi",
            connectionId: "00000000-0000-4000-8000-000000000001",
            epoch: "00000000-0000-4000-8000-000000000002",
            computerId: "fixture-computer",
            computerProviderRef: "fixture-ref",
            computerHomeKey: "fixture-home",
            spaceId: "fixture-space",
            state: "ready",
            region: "global",
          },
        },
      };
      const process = nativeInferenceProcess(
        request,
        home,
        sessions,
        run.credentials,
        run.guardPath!,
      );
      const signal = AbortSignal.timeout(15000);
      const channel = new NativeJsonlChannel(process.handle, signal, true);
      const events: AgentRuntimeEvent[] = [];
      try {
        await runKimiProtocol(channel, {
          request,
          tools: [tool],
          prompt: request.prompt,
          nativeSessionId: resume ? nativeSessionId : undefined,
          onSession: (id) => {
            nativeSessionId = id;
          },
          signal,
          emit: (event) => events.push(event),
          callTool,
          setInterrupt: () => {},
        });
      } finally {
        await channel.close();
      }
      expect(
        events
          .filter((event) => event.type === "text")
          .map((event) => event.text)
          .join(""),
      ).toBe(resume ? "Native resume complete." : "Native read complete.");
      expect(events.filter((event) => event.type === "usage")).toHaveLength(2);
      expect(process.output()).not.toContain("fake-refreshed-access");
      expect(process.output()).not.toContain("fake-native-refresh");
      await rm(home, { recursive: true, force: true });
      await mkdir(home);
    }
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(completions).toHaveLength(4);
    expect(JSON.stringify(completions[2]!.messages)).toContain("Native read complete.");
    expect(JSON.stringify(completions[2]!.messages)).toContain("fixture native file contents");
    expect(failures).toEqual([]);
    const sessionContents = await privateSessionContents(sessions);
    expect(sessionContents).not.toContain("fake-refreshed-access");
    expect(sessionContents).not.toContain("fake-native-refresh");
    // A fresh native home contains no copied vendor config/session state. Only
    // the native private credentials and lock directory survive this restart.
    const restarted = await harness({}, native, run.credentials);
    expect((await restarted.request("rakazo/auth/status")).result).toMatchObject({
      state: "ready",
    });
    expect(deviceRequests).toBe(1);
    expect((await restarted.request("rakazo/auth/logout")).result).toEqual({ state: "signed_out" });
    expect((await restarted.request("rakazo/auth/status")).result).toEqual({ state: "signed_out" });
    expect(run.output()).not.toContain("fake-native-refresh");
    expect(run.output()).not.toContain("fake-refreshed-access");
    expect(run.errors()).toBe("");
  }, 30000);
});
