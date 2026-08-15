import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { resolveSupervisorToken } from "@rakazo/core";
import Docker from "dockerode";
import { Hono } from "hono";
import { z } from "zod";
import {
  COMPUTER_IMAGE,
  containerCreateOptions,
  containerNameFor,
  type SandboxInput,
  screenUrlFor,
  xdotoolCommand,
} from "./computer-spec.js";

loadRootEnv();

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });
const computerContext =
  process.env.RAKAZO_COMPUTER_CONTEXT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../computer");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const dataDir = path.resolve(repositoryRoot, process.env.DATA_DIR ?? "./data");
let imageReady: Promise<void> | undefined;
let supervisorInfo: Docker.ContainerInspectInfo | undefined;
const supervisorToken = resolveSupervisorToken(process.env);

const computerActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("key"), key: z.string(), modifiers: z.array(z.string()).optional() }),
  z.object({
    kind: z.literal("pointer"),
    x: z.number(),
    y: z.number(),
    button: z.enum(["left", "right"]).optional(),
    type: z.enum(["move", "down", "up", "click"]),
  }),
  z.object({ kind: z.literal("clipboard"), text: z.string() }),
  z.object({
    kind: z.literal("scroll"),
    direction: z.enum(["up", "down"]),
    amount: z.number().optional(),
  }),
  z.object({ kind: z.literal("wait"), ms: z.number() }),
  z.object({ kind: z.literal("open"), path: z.string() }),
  z.object({ kind: z.literal("launch"), application: z.string(), uri: z.string().optional() }),
]);

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, image: COMPUTER_IMAGE }));

app.use("/computers", async (c, next) => {
  if (!hasValidSupervisorToken(c.req.header("authorization"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});
app.use("/computers/*", async (c, next) => {
  if (!hasValidSupervisorToken(c.req.header("authorization"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

app.post("/computers", async (c) => {
  const body = z
    .object({
      botId: z.string().min(1),
      homePath: z.string().min(1),
      workspaceId: z.string().min(1),
    })
    .parse(await c.req.json());
  try {
    assertRequestIdentity(c.req.header("x-rakazo-bot-id"), c.req.header("x-rakazo-workspace-id"), {
      botId: body.botId,
      workspaceId: body.workspaceId,
    });
    await ensureComputerImage();
    const runtimeInfo = await inspectSupervisorContainer();
    const networkMode = computerNetworkMode(runtimeInfo);
    const serviceHomePath = path.resolve(body.homePath);
    assertBotHomePath(serviceHomePath, body.botId);
    await mkdir(serviceHomePath, { recursive: true });
    const homePath = hostHomePath(serviceHomePath, runtimeInfo);
    const existing = await findBotContainer(body.botId, body.workspaceId);
    if (existing) {
      const info = await existing.inspect();
      const desired = await docker.getImage(COMPUTER_IMAGE).inspect();
      if (
        info.Image !== desired.Id ||
        (networkMode && info.HostConfig.NetworkMode !== networkMode)
      ) {
        await existing.remove({ force: true }).catch(() => undefined);
      } else {
        if (!info.State.Running) await existing.start();
        const screenUrl = await publishedScreenUrl(existing, info.State.Running ? info : undefined);
        return c.json({ id: existing.id, image: COMPUTER_IMAGE, screenUrl, resumed: true });
      }
    }
    const name = containerNameFor(body.botId);
    const container = await docker.createContainer(
      containerCreateOptions({
        name,
        image: COMPUTER_IMAGE,
        botId: body.botId,
        workspaceId: body.workspaceId,
        homePath,
        networkMode,
      }),
    );
    await container.start();
    const screenUrl = await publishedScreenUrl(container);
    return c.json({ id: container.id, image: COMPUTER_IMAGE, screenUrl, resumed: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
  }
});

app.get("/computers/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const { container, info } = await managedContainer(
      id,
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-workspace-id"),
    );
    const screenUrl = await publishedScreenUrl(container, info);
    return c.json({
      id,
      running: Boolean(info.State.Running),
      image: info.Config.Image,
      screenUrl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 404);
  }
});

app.post("/computers/:id/exec", async (c) => {
  const id = c.req.param("id");
  const body = z
    .object({
      argv: z.array(z.string()),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .parse(await c.req.json());
  try {
    const { container } = await managedContainer(
      id,
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-workspace-id"),
    );
    const result = await runContainerCommand(
      container,
      body.argv.length ? body.argv : ["/bin/echo", "ready"],
      {
        workingDir: body.cwd ?? "/home/rakazo",
        env: [
          "DISPLAY=:1",
          "HOME=/home/rakazo",
          "PATH=/home/rakazo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "NPM_CONFIG_PREFIX=/home/rakazo/.local",
          "PIP_USER=1",
          ...Object.entries(body.env ?? {}).map(([k, v]) => `${k}=${v}`),
        ],
      },
    );
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ stdout: "", stderr: message, code: 1 }, 200);
  }
});

app.post("/computers/:id/observe", async (c) => {
  try {
    const { container } = await managedContainer(
      c.req.param("id"),
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-workspace-id"),
    );
    return c.json(await observeContainer(container));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
  }
});

app.post("/computers/:id/actions", async (c) => {
  const body = z
    .object({
      actions: z.array(computerActionSchema).max(24),
      observe: z.boolean().optional(),
      settleMs: z.number().min(0).max(5_000).optional(),
    })
    .parse(await c.req.json());
  try {
    const { container } = await managedContainer(
      c.req.param("id"),
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-workspace-id"),
    );
    if (body.actions.length) await applyContainerActions(container, body.actions);
    if (body.settleMs) await new Promise((resolve) => setTimeout(resolve, body.settleMs));
    return c.json({
      completed: body.actions.length,
      ...(body.observe === false ? {} : { observation: await observeContainer(container) }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
  }
});

app.get("/computers/:id/files", async (c) => {
  try {
    const { container } = await managedContainer(
      c.req.param("id"),
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-workspace-id"),
    );
    const relative = normalizeWorkspaceRelative(c.req.query("path") ?? "");
    const target = workspaceTarget(relative);
    if (c.req.query("mode") === "read") {
      const maxBytesRaw = c.req.query("maxBytes");
      const maxBytes = maxBytesRaw === undefined ? undefined : Number(maxBytesRaw);
      if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
        return c.json({ error: "invalid maxBytes" }, 400);
      }
      const script = [
        "import base64, sys",
        "target, limit = sys.argv[1], int(sys.argv[2])",
        "with open(target, 'rb') as source:",
        "  content = source.read() if limit < 0 else source.read(limit + 1)",
        "if limit >= 0 and len(content) > limit: sys.exit(42)",
        "sys.stdout.write(base64.b64encode(content).decode())",
      ].join("\n");
      const result = await runContainerCommand(container, [
        "python3",
        "-c",
        script,
        target,
        String(maxBytes ?? -1),
      ]);
      if (result.code === 42) {
        return c.json({ error: `computer file exceeds ${maxBytes} bytes` }, 413);
      }
      if (result.code !== 0) return c.json({ error: result.stderr || "file not found" }, 404);
      return c.json({ content: result.stdout.trim() });
    }
    const script = [
      "import json, os, stat, sys",
      "root, rel = sys.argv[1], sys.argv[2]",
      "out = []",
      "for item in os.scandir(root):",
      "  if item.is_symlink(): continue",
      "  info = item.stat(follow_symlinks=False)",
      "  child = '/'.join(x for x in (rel, item.name) if x)",
      "  out.append({'path': child, 'kind': 'dir' if item.is_dir(follow_symlinks=False) else 'file', 'size': info.st_size, **({'executable': True} if item.is_file(follow_symlinks=False) and bool(info.st_mode & stat.S_IXUSR) else {})})",
      "print(json.dumps(sorted(out, key=lambda x: x['path'])))",
    ].join("\n");
    const result = await runContainerCommand(container, [
      "python3",
      "-c",
      script,
      target,
      relative,
    ]);
    if (result.code !== 0) return c.json({ error: result.stderr || "directory not found" }, 404);
    return c.json(JSON.parse(result.stdout));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 400);
  }
});

app.post("/computers/:id/files", async (c) => {
  const body = z
    .object({
      path: z.string(),
      content: z.string().max(16 * 1024 * 1024),
      executable: z.boolean().optional(),
    })
    .parse(await c.req.json());
  try {
    const { container } = await managedContainer(
      c.req.param("id"),
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-workspace-id"),
    );
    const target = workspaceTarget(normalizeWorkspaceRelative(body.path));
    await writeContainerFile(
      container,
      target,
      Buffer.from(body.content, "base64"),
      body.executable,
    );
    return c.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 400);
  }
});

app.get("/computers/:id/screen", async (c) => {
  const id = c.req.param("id");
  try {
    const { container, info } = await managedContainer(
      id,
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-workspace-id"),
    );
    const screenUrl = await publishedScreenUrl(container, info);
    return c.redirect(screenUrl);
  } catch {
    return c.json({ error: "computer not found" }, 404);
  }
});

app.post("/computers/:id/input", async (c) => {
  const id = c.req.param("id");
  const body = z
    .object({
      input: z.object({
        kind: z.enum(["key", "pointer", "clipboard"]),
        key: z.string().optional(),
        modifiers: z.array(z.string()).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        button: z.enum(["left", "right"]).optional(),
        type: z.enum(["move", "down", "up", "click"]).optional(),
        text: z.string().optional(),
      }),
      leaseId: z.string().optional(),
    })
    .parse(await c.req.json());
  const input = toSandboxInput(body.input);
  try {
    const { container } = await managedContainer(
      id,
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-workspace-id"),
    );
    const result = await runContainerCommand(container, [
      "env",
      "DISPLAY=:1",
      ...xdotoolCommand(input),
    ]);
    if (result.code !== 0) {
      return c.json({ ok: false, error: "input failed" }, 500);
    }
    return c.json({ ok: true, leaseId: body.leaseId ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, error: message }, 500);
  }
});

app.post("/computers/:id/stop", async (c) => {
  try {
    const { container } = await managedContainer(
      c.req.param("id"),
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-workspace-id"),
    );
    await container.stop().catch(() => undefined);
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "computer not found" }, 404);
  }
});

app.delete("/computers/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const { container } = await managedContainer(
      id,
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-workspace-id"),
    );
    await container.remove({ force: true }).catch(() => undefined);
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "computer not found" }, 404);
  }
});

const port = Number(process.env.SUPERVISOR_PORT ?? 7091);
const hostname = process.env.SUPERVISOR_HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, hostname, port }, () => {
  console.log(`sandbox supervisor on http://${hostname}:${port}`);
});

async function ensureComputerImage() {
  if (!imageReady) {
    imageReady = (async () => {
      try {
        await docker.getImage(COMPUTER_IMAGE).inspect();
        return;
      } catch {
        // build below
      }
      const dockerfile = path.join(computerContext, "Dockerfile");
      if (!existsSync(dockerfile)) {
        throw new Error(
          `Missing ${COMPUTER_IMAGE}. Build it with: docker build -t ${COMPUTER_IMAGE} infra/sandboxes/computer`,
        );
      }
      const stream = await docker.buildImage(
        {
          context: computerContext,
          src: [
            "Dockerfile",
            "start.sh",
            "rakazo-browser",
            "embed.html",
            "fluxbox.init",
            "fluxbox.apps",
            "fluxbox.menu",
          ],
        },
        { t: COMPUTER_IMAGE },
      );
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
      });
      await docker.getImage(COMPUTER_IMAGE).inspect();
    })();
  }
  await imageReady;
}

async function findBotContainer(botId: string, workspaceId: string) {
  const listed = await docker.listContainers({
    all: true,
    filters: { label: [`rakazo.botId=${botId}`, `rakazo.workspaceId=${workspaceId}`] },
  });
  for (const item of listed) {
    const container = docker.getContainer(item.Id);
    const info = await container.inspect();
    if (isRakazoContainer(info, botId, workspaceId)) return container;
  }
  return undefined;
}

async function managedContainer(id: string, botId?: string, workspaceId?: string) {
  if (!botId || !workspaceId) throw new Error("missing computer identity");
  const container = docker.getContainer(id);
  const info = await container.inspect();
  if (!isRakazoContainer(info, botId, workspaceId)) throw new Error("computer identity mismatch");
  return { container, info };
}

function isRakazoContainer(info: Docker.ContainerInspectInfo, botId: string, workspaceId: string) {
  const labels = info.Config.Labels ?? {};
  const managed = labels["rakazo.managed"] === "true" || info.Config.Image === COMPUTER_IMAGE;
  return (
    managed && labels["rakazo.botId"] === botId && labels["rakazo.workspaceId"] === workspaceId
  );
}

function assertRequestIdentity(
  botId: string | undefined,
  workspaceId: string | undefined,
  expected: { botId: string; workspaceId: string },
) {
  if (botId !== expected.botId || workspaceId !== expected.workspaceId) {
    throw new Error("computer identity mismatch");
  }
}

function assertBotHomePath(homePath: string, botId: string) {
  const expected = path.join(dataDir, "homes", botId);
  if (homePath !== expected) {
    throw new Error("computer home must be the bot's home directory");
  }
}

function hostHomePath(serviceHomePath: string, info: Docker.ContainerInspectInfo | undefined) {
  const dataMount = info?.Mounts.find((mount) => mount.Destination === dataDir);
  if (!dataMount?.Source) return serviceHomePath;
  return path.join(dataMount.Source, path.relative(dataDir, serviceHomePath));
}

function hasValidSupervisorToken(authorization: string | undefined) {
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const actual = Buffer.from(supervisorToken);
  const candidate = Buffer.from(supplied);
  return actual.length === candidate.length && timingSafeEqual(actual, candidate);
}

function loadRootEnv() {
  const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../.env");
  if (!existsSync(envFile)) return;
  try {
    loadEnvFile(envFile);
  } catch {
    // The API reports malformed or missing deployment configuration in more detail.
  }
}

async function publishedScreenUrl(
  container: Docker.Container,
  initialInfo?: Docker.ContainerInspectInfo,
) {
  for (let i = 0; i < 30; i += 1) {
    const info = i === 0 && initialInfo ? initialInfo : await container.inspect();
    if (process.env.SANDBOX_SCREEN_NETWORK === "internal") {
      const networkMode = info.HostConfig.NetworkMode;
      const address = networkMode
        ? info.NetworkSettings?.Networks?.[networkMode]?.IPAddress
        : undefined;
      if (address) return screenUrlFor("6080", address);
    }
    const hostPort = info.NetworkSettings?.Ports?.["6080/tcp"]?.[0]?.HostPort;
    if (hostPort) return screenUrlFor(hostPort);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("computer screen port was not published");
}

function computerNetworkMode(info: Docker.ContainerInspectInfo | undefined) {
  if (process.env.SANDBOX_SCREEN_NETWORK !== "internal") return undefined;
  return info ? Object.keys(info.NetworkSettings.Networks)[0] : undefined;
}

async function inspectSupervisorContainer() {
  if (supervisorInfo || !process.env.HOSTNAME) return supervisorInfo;
  try {
    supervisorInfo = await docker.getContainer(process.env.HOSTNAME).inspect();
    return supervisorInfo;
  } catch {
    return undefined;
  }
}

function toSandboxInput(input: {
  kind: "key" | "pointer" | "clipboard";
  key?: string;
  modifiers?: string[];
  x?: number;
  y?: number;
  button?: "left" | "right";
  type?: "move" | "down" | "up" | "click";
  text?: string;
}): SandboxInput {
  if (input.kind === "key")
    return { kind: "key", key: input.key ?? "", modifiers: input.modifiers };
  if (input.kind === "clipboard") return { kind: "clipboard", text: input.text ?? "" };
  return {
    kind: "pointer",
    x: input.x ?? 0,
    y: input.y ?? 0,
    button: input.button,
    type: input.type ?? "click",
  };
}

function stripDockerStream(buffer: Buffer) {
  // docker multiplexed stream: 8-byte header per frame
  if (buffer.length >= 8 && (buffer[0] ?? 99) <= 2) {
    const parts: string[] = [];
    let offset = 0;
    while (offset + 8 <= buffer.length) {
      const size = buffer.readUInt32BE(offset + 4);
      parts.push(buffer.subarray(offset + 8, offset + 8 + size).toString("utf8"));
      offset += 8 + size;
    }
    return parts.join("");
  }
  return buffer.toString("utf8");
}

async function runContainerCommand(
  container: Docker.Container,
  argv: string[],
  options: { workingDir?: string; env?: string[] } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const exec = await container.exec({
    Cmd: argv,
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: options.workingDir ?? "/home/rakazo",
    Env: options.env ?? ["DISPLAY=:1", "HOME=/home/rakazo"],
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (data: Buffer) => chunks.push(data));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  const inspect = await exec.inspect();
  return {
    stdout: stripDockerStream(Buffer.concat(chunks)),
    stderr: "",
    code: inspect.ExitCode ?? 0,
  };
}

function containerActionStep(
  action: z.infer<typeof computerActionSchema>,
): { argv: string[] } | { waitMs: number } {
  if (action.kind === "wait") {
    return { waitMs: Math.min(Math.max(action.ms, 0), 5_000) };
  }
  let argv: string[];
  if (action.kind === "key" || action.kind === "pointer" || action.kind === "clipboard") {
    argv = ["env", "DISPLAY=:1", ...xdotoolCommand(toSandboxInput(action))];
  } else if (action.kind === "scroll") {
    argv = [
      "env",
      "DISPLAY=:1",
      "xdotool",
      "click",
      "--repeat",
      String(Math.min(Math.max(Math.round(action.amount ?? 3), 1), 20)),
      action.direction === "up" ? "4" : "5",
    ];
  } else if (action.kind === "open") {
    const target = /^https?:\/\//i.test(action.path)
      ? action.path
      : workspaceTarget(normalizeWorkspaceRelative(action.path));
    argv = ["env", "DISPLAY=:1", "xdg-open", target];
  } else {
    argv = ["env", "DISPLAY=:1", action.application, ...(action.uri ? [action.uri] : [])];
  }
  return { argv };
}

async function applyContainerActions(
  container: Docker.Container,
  actions: Array<z.infer<typeof computerActionSchema>>,
) {
  const script = [
    "import json, subprocess, sys, time",
    "for step in json.loads(sys.argv[1]):",
    "  if 'waitMs' in step: time.sleep(step['waitMs'] / 1000)",
    "  else:",
    "    result = subprocess.run(step['argv'])",
    "    if result.returncode: sys.exit(result.returncode)",
  ].join("\n");
  const result = await runContainerCommand(container, [
    "python3",
    "-c",
    script,
    JSON.stringify(actions.map(containerActionStep)),
  ]);
  if (result.code !== 0) throw new Error(result.stderr || "computer action failed");
}

async function observeContainer(container: Docker.Container) {
  const command = [
    "set -e",
    "export DISPLAY=:1",
    'printf "GEOM %s\\n" "$(xdotool getdisplaygeometry 2>/dev/null || echo 1280 800)"',
    'printf "CURSOR %s\\n" "$(xdotool getmouselocation --shell 2>/dev/null | tr "\\n" " " || true)"',
    'wid="$(xdotool getactivewindow 2>/dev/null || true)"',
    'printf "WINDOW %s\\n" "$wid"',
    'printf "TITLE %s\\n" "$(test -n "$wid" && xdotool getwindowname "$wid" 2>/dev/null || true)"',
    'printf "IMAGE "',
    "import -window root png:- 2>/dev/null | base64 -w0",
    'printf "\\n"',
  ].join("; ");
  const result = await runContainerCommand(container, ["bash", "-lc", command]);
  if (result.code !== 0) throw new Error(result.stderr || "screen capture failed");
  return parseObservation(result.stdout);
}

async function writeContainerFile(
  container: Docker.Container,
  target: string,
  content: Buffer,
  executable = false,
) {
  const script = [
    "import os, sys",
    "target = sys.argv[1]",
    "os.makedirs(os.path.dirname(target), exist_ok=True)",
    "with open(target, 'wb') as f: f.write(sys.stdin.buffer.read())",
    `os.chmod(target, ${executable ? "0o700" : "0o600"})`,
  ].join("\n");
  const exec = await container.exec({
    Cmd: ["python3", "-c", script, target],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: "/home/rakazo",
    Env: ["HOME=/home/rakazo"],
  });
  const stream = await exec.start({ hijack: true, stdin: true });
  const chunks: Buffer[] = [];
  stream.on("data", (data: Buffer) => chunks.push(data));
  stream.end(content);
  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  const inspect = await exec.inspect();
  if ((inspect.ExitCode ?? 0) !== 0) {
    throw new Error(stripDockerStream(Buffer.concat(chunks)) || "file write failed");
  }
}

function normalizeWorkspaceRelative(value: string) {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("path escapes the computer workspace");
  }
  return segments.join("/");
}

function workspaceTarget(relative: string) {
  return relative ? path.posix.join("/home/rakazo", relative) : "/home/rakazo";
}

function parseObservation(output: string) {
  const geometry = output.match(/^GEOM\s+(\d+)\s+(\d+)$/m);
  const cursorLine = output.match(/^CURSOR\s+(.+)$/m)?.[1] ?? "";
  const cursorX = Number(cursorLine.match(/X=(\d+)/)?.[1]);
  const cursorY = Number(cursorLine.match(/Y=(\d+)/)?.[1]);
  const windowId = output.match(/^WINDOW\s*(.*)$/m)?.[1]?.trim();
  const title = output.match(/^TITLE\s*(.*)$/m)?.[1]?.trim();
  const image = output.match(/^IMAGE\s+([A-Za-z0-9+/=]+)$/m)?.[1];
  if (!image) throw new Error("screen capture returned no image");
  return {
    image,
    mimeType: "image/png" as const,
    width: Number(geometry?.[1] ?? 1280),
    height: Number(geometry?.[2] ?? 800),
    ...(Number.isFinite(cursorX) && Number.isFinite(cursorY)
      ? { cursor: { x: cursorX, y: cursorY } }
      : {}),
    ...(windowId ? { activeWindow: { id: windowId, ...(title ? { title } : {}) } } : {}),
  };
}
