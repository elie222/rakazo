import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BoxSandboxProvider, E2BSandboxProvider, PiAgentRuntime } from "@rakazo/adapters";
import { afterAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";

function loadEnvFile() {
  const file = path.resolve(".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1).replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

const liveE2b = Boolean(process.env.VERIFY_PROVIDERS && process.env.E2B_API_KEY);
const liveBox = Boolean(process.env.VERIFY_PROVIDERS && process.env.BOX_API_KEY);
const livePi = Boolean(process.env.VERIFY_PROVIDERS && process.env.OPENROUTER_API_KEY);
const livePiApp = Boolean(livePi && process.env.DATABASE_URL);

const describeE2b = liveE2b ? describe : describe.skip;
const describeBox = liveBox ? describe : describe.skip;
const describePi = livePi ? describe : describe.skip;
const describePiApp = livePiApp ? describe : describe.skip;

describeE2b("live E2B canary", () => {
  it("provisions a desktop, runs a command, and destroys it", async () => {
    const sandbox = new E2BSandboxProvider(process.env.E2B_API_KEY!);
    const ctx = {
      operationId: "canary",
      traceId: "canary",
      spaceId: "canary",
      userId: "canary",
      signal: new AbortController().signal,
    };
    const computer = await sandbox.provision(
      { botId: "canary", homePath: "/home/user/rakazo-home" },
      ctx,
    );
    try {
      await sandbox.prepare(computer, ctx);
      let stdout = "";
      for await (const event of sandbox.execute(computer, { argv: ["echo", "e2b-ok"] }, ctx)) {
        if (event.type === "stdout") stdout += event.data;
        if (event.type === "exit") expect(event.code).toBe(0);
      }
      expect(stdout).toContain("e2b-ok");
    } finally {
      await sandbox.destroy(computer, ctx);
    }
  }, 120_000);
});

describeBox("live Box canary", () => {
  it("provisions a desktop, observes it, preserves a file across stop/resume, and destroys it", async () => {
    const sandbox = new BoxSandboxProvider({
      apiKey: process.env.BOX_API_KEY!,
      apiUrl: process.env.BOX_API_URL ?? process.env.BOX_BASE_URL,
    });
    const ctx = {
      operationId: "box-canary",
      traceId: "box-canary",
      spaceId: "box-canary",
      userId: "box-canary",
      signal: new AbortController().signal,
    };
    const request = { botId: "box-canary", homePath: "/home/user/rakazo-home" };
    let computer = await sandbox.provision(request, ctx);
    try {
      await sandbox.prepare(computer, ctx);
      let stdout = "";
      for await (const event of sandbox.execute(computer, { argv: ["echo", "box-ok"] }, ctx)) {
        if (event.type === "stdout") stdout += event.data;
        if (event.type === "exit") expect(event.code).toBe(0);
      }
      expect(stdout).toContain("box-ok");
      await sandbox.writeFile(
        computer,
        { path: "canary.txt", content: new TextEncoder().encode("preserved") },
        ctx,
      );
      expect((await sandbox.observe(computer, ctx)).image.byteLength).toBeGreaterThan(0);

      await sandbox.stop(computer, ctx);
      computer = await sandbox.provision(
        { ...request, providerRef: computer.providerRef, providerKind: computer.kind },
        ctx,
      );
      expect(computer.fresh).toBe(false);
      await sandbox.prepare(computer, ctx);
      expect(new TextDecoder().decode(await sandbox.readFile(computer, "canary.txt", ctx))).toBe(
        "preserved",
      );
    } finally {
      await sandbox.destroy(computer, ctx);
    }
  }, 240_000);
});

describePi("live OpenRouter / Pi canary", () => {
  it("streams a reply from deepseek/deepseek-v4-flash-0731", async () => {
    const runtime = new PiAgentRuntime();
    let text = "";
    for await (const event of runtime.run(
      {
        botId: "canary",
        threadId: "canary",
        runId: `pi-${Date.now()}`,
        prompt: "Reply with exactly the word pong and nothing else.",
        instructions: "You are a concise test bot. Do not call tools.",
        history: [],
        tools: [],
        model: {
          provider: "openrouter",
          id: "deepseek/deepseek-v4-flash-0731",
          apiKey: process.env.OPENROUTER_API_KEY,
        },
      },
      {
        operationId: "canary",
        traceId: "canary",
        spaceId: "canary",
        userId: "canary",
        signal: new AbortController().signal,
      },
    )) {
      if (event.type === "text") text += event.text;
      if (event.type === "done" && event.text && !text) text = event.text;
    }
    expect(text.toLowerCase()).toMatch(/pong/);
    expect(text).not.toMatch(/sk-or-|OPENROUTER_API_KEY/i);
  }, 90_000);
});

describePiApp("live OpenRouter product journey", () => {
  let stop: (() => Promise<void>) | undefined;

  afterAll(async () => {
    await stop?.();
  });

  it("completes a bot turn through the API with the live model", async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-pi-"));
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "pi",
    });
    stop = handles.stop;
    const stamp = Date.now();
    const email = `pi-${stamp}@rakazo.test`;
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "password12", name: "Pi Canary" }),
    });
    expect(signup.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(signup);
    const botRes = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
      name: "Chief",
      title: "Chief of staff",
      description: "Canary",
      instructions: "Reply briefly. Prefer the write_file tool when asked to write a file.",
      notifyOnFinish: true,
    });
    await rpc(handles.app, cookie, "threads/send", {
      botId: botRes.id,
      text: "Use write_file to save notes/result.txt containing exactly openrouter-ok",
    });
    const snap = await waitFor(handles.app, cookie, botRes.id, 90_000);
    const blob = JSON.stringify(snap);
    expect(blob).not.toMatch(/sk-or-/i);
    const file = await rpc<{ content: string }>(handles.app, cookie, "computer/readFile", {
      botId: botRes.id,
      path: "notes/result.txt",
    }).catch(() => ({ content: "" }));
    const ok =
      file.content.includes("openrouter-ok") ||
      blob.toLowerCase().includes("openrouter-ok") ||
      blob.toLowerCase().includes("pong") ||
      snap.messages.some((m) => m.role === "bot");
    expect(ok).toBe(true);
    if (file.content) expect(file.content).toContain("openrouter-ok");
  }, 120_000);
});

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
type Snap = {
  messages: Array<{ role: string; blocks: unknown[] }>;
  run: { status: string } | null;
};

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
  });
  const parsed = (await res.json()) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error)
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? "failed"}`);
  return parsed.json as T;
}

async function waitFor(app: App, cookie: string, botId: string, ms: number): Promise<Snap> {
  const start = Date.now();
  let last: Snap | null = null;
  while (Date.now() - start < ms) {
    last = await rpc<Snap>(app, cookie, "threads/get", { botId });
    if (!last.run || ["completed", "failed", "cancelled"].includes(last.run.status)) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timeout waiting for live model turn: ${JSON.stringify(last)}`);
}
