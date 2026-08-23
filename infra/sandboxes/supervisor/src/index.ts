import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { boundedSandboxCommandTimeoutMs, resolveSupervisorToken } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import Docker from "dockerode";
import { Hono } from "hono";
import { z } from "zod";
import {
  COMPUTER_IMAGE,
  containerCreateOptions,
  containerNameFor,
  screenPorts,
  screenUrlFor,
  xdotoolCommand,
} from "./computer-spec.js";
import {
  assertRequestIdentity,
  clearComputerScreenRegistry,
  completeReleasedScreen,
  computerActionSchema,
  containerActionStep,
  ensureScreenCommand,
  hasValidBearerToken,
  interactiveScreenCommand,
  nextScreenIndex,
  normalizeWorkspaceRelative,
  parseObservation,
  releaseAssignedScreen,
  type ScreenAssignment,
  sandboxCommandTimedOut,
  sandboxTimeoutCommand,
  stopExtraScreenCommand,
  toSandboxInput,
  workspaceTarget,
} from "./supervisor-logic.js";

loadRootEnv();

const dockerSocketPath = resolveDockerSocketPath();
const docker = dockerSocketPath ? new Docker({ socketPath: dockerSocketPath }) : new Docker();
const computerContext =
  process.env.RAKAZO_COMPUTER_CONTEXT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../computer");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const dataDir = path.resolve(repositoryRoot, process.env.DATA_DIR ?? "./data");
let imageReady: Promise<void> | undefined;
let supervisorInfo: Docker.ContainerInspectInfo | undefined;
const supervisorToken = resolveSupervisorToken(process.env);
const computerScreens = new Map<string, Map<string, ScreenAssignment>>();

const app = new Hono();

export { app as supervisorApp };

export function resolveDockerSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  if (env.DOCKER_HOST) return undefined;
  return (
    env.DOCKER_SOCKET ?? (platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock")
  );
}

app.get("/health", (c) => c.json({ ok: true, image: COMPUTER_IMAGE }));

app.use("/computers", async (c, next) => {
  if (!hasValidBearerToken(c.req.header("authorization"), supervisorToken)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});
app.use("/computers/*", async (c, next) => {
  if (!hasValidBearerToken(c.req.header("authorization"), supervisorToken)) {
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
      timeoutMs: z.number().int().positive().optional(),
    })
    .parse(await c.req.json());
  try {
    const { container } = await managedContainer(
      id,
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-workspace-id"),
    );
    const screenId = c.req.header("x-rakazo-screen-id") || c.req.header("x-rakazo-bot-id") || id;
    const screenIndex = computerScreens.get(id)?.get(screenId)?.index ?? 0;
    const layout = screenPorts(screenIndex);
    const result = await runContainerCommand(
      container,
      body.argv.length ? body.argv : ["/bin/echo", "ready"],
      {
        workingDir: body.cwd ?? "/home/rakazo",
        env: [
          `DISPLAY=${layout.display}`,
          "HOME=/home/rakazo",
          "PATH=/home/rakazo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "NPM_CONFIG_PREFIX=/home/rakazo/.local",
          "PIP_USER=1",
          ...Object.entries(body.env ?? {}).map(([k, v]) => `${k}=${v}`),
        ],
        timeoutMs: boundedSandboxCommandTimeoutMs(body.timeoutMs),
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
    const { container, layout } = await managedScreen(
      c.req.param("id"),
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-workspace-id"),
      c.req.header("x-rakazo-screen-id"),
      c.req.header("x-rakazo-screen-lease-id"),
    );
    return c.json(await observeContainer(container, layout.display));
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
    const { container, layout } = await managedScreen(
      c.req.param("id"),
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-workspace-id"),
      c.req.header("x-rakazo-screen-id"),
      c.req.header("x-rakazo-screen-lease-id"),
    );
    if (body.actions.length) await applyContainerActions(container, body.actions, layout.display);
    if (body.settleMs) await new Promise((resolve) => setTimeout(resolve, body.settleMs));
    return c.json({
      completed: body.actions.length,
      ...(body.observe === false
        ? {}
        : { observation: await observeContainer(container, layout.display) }),
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
    const { container, info, layout } = await managedScreen(
      id,
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-workspace-id"),
      c.req.header("x-rakazo-screen-id"),
      c.req.header("x-rakazo-screen-lease-id"),
    );
    const screenUrl = await publishedScreenUrl(container, info, layout.viewPort);
    return c.redirect(screenUrl);
  } catch {
    return c.json({ error: "computer not found" }, 404);
  }
});

app.post("/computers/:id/screen-mode", async (c) => {
  const body = z
    .object({
      interactive: z.boolean(),
      controlToken: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,128}$/)
        .optional(),
      revokeControl: z.boolean().optional(),
    })
    .refine((value) => !value.interactive || value.controlToken, {
      message: "interactive screen requires a control token",
    })
    .parse(await c.req.json());
  try {
    const { container, info, layout } = await managedScreen(
      c.req.param("id"),
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-workspace-id"),
      c.req.header("x-rakazo-screen-id"),
      c.req.header("x-rakazo-screen-lease-id"),
    );
    if (body.interactive || body.revokeControl !== false) {
      await setInteractiveScreen(container, body.interactive, body.controlToken, layout);
    }
    const screenUrl = await publishedScreenUrl(
      container,
      info,
      body.interactive ? layout.controlPort : layout.viewPort,
    );
    return c.json({ screenUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 400);
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
    const { container, layout } = await managedScreen(
      id,
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-workspace-id"),
      c.req.header("x-rakazo-screen-id"),
      c.req.header("x-rakazo-screen-lease-id"),
    );
    const result = await runContainerCommand(container, [
      "env",
      `DISPLAY=${layout.display}`,
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

app.delete("/computers/:id/screen", async (c) => {
  try {
    const { container } = await managedContainer(
      c.req.param("id"),
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-workspace-id"),
    );
    const screenId =
      c.req.header("x-rakazo-screen-id") || c.req.header("x-rakazo-bot-id") || c.req.param("id");
    const assigned = computerScreens.get(c.req.param("id"));
    const index = assigned
      ? releaseAssignedScreen(assigned, screenId, c.req.header("x-rakazo-screen-lease-id"))
      : undefined;
    const stop = index !== undefined ? stopExtraScreenCommand(index) : "";
    try {
      if (stop) {
        await runContainerCommand(container, ["bash", "-lc", stop]).catch(() => undefined);
      }
    } finally {
      if (assigned && index !== undefined) completeReleasedScreen(assigned, screenId, index);
      if (assigned?.size === 0) computerScreens.delete(c.req.param("id"));
    }
    return c.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 404);
  }
});

app.post("/computers/:id/stop", async (c) => {
  const id = c.req.param("id");
  try {
    const { container } = await managedContainer(
      id,
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-workspace-id"),
    );
    await container.stop().catch(() => undefined);
    clearComputerScreenRegistry(computerScreens, id);
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
    clearComputerScreenRegistry(computerScreens, id);
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "computer not found" }, 404);
  }
});

function startSupervisor() {
  const port = Number(process.env.SUPERVISOR_PORT ?? 7091);
  const hostname = process.env.SUPERVISOR_HOST ?? "127.0.0.1";
  return serve({ fetch: app.fetch, hostname, port }, () => {
    console.log(`sandbox supervisor on http://${hostname}:${port}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startSupervisor();
}

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

async function managedScreen(
  id: string,
  botId: string | undefined,
  workspaceId: string | undefined,
  screenId: string | undefined,
  screenLeaseId: string | undefined,
) {
  const { container, info } = await managedContainer(id, botId, workspaceId);
  let assigned = computerScreens.get(id);
  if (!assigned) {
    assigned = new Map();
    computerScreens.set(id, assigned);
  }
  const index = nextScreenIndex(assigned, screenId || botId || id, screenLeaseId);
  const layout = screenPorts(index);
  const ensured = await runContainerCommand(container, ["bash", "-lc", ensureScreenCommand(index)]);
  if (ensured.code !== 0) {
    assigned.delete(screenId || botId || id);
    throw new Error(ensured.stderr || `computer screen ${layout.display} failed to start`);
  }
  return { container, info, layout };
}

function isRakazoContainer(info: Docker.ContainerInspectInfo, botId: string, workspaceId: string) {
  const labels = info.Config.Labels ?? {};
  const managed = labels["rakazo.managed"] === "true" || info.Config.Image === COMPUTER_IMAGE;
  return (
    managed && labels["rakazo.botId"] === botId && labels["rakazo.workspaceId"] === workspaceId
  );
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
async function publishedScreenUrl(
  container: Docker.Container,
  initialInfo?: Docker.ContainerInspectInfo,
  containerPort = "6080",
) {
  for (let i = 0; i < 30; i += 1) {
    const info = i === 0 && initialInfo ? initialInfo : await container.inspect();
    if (process.env.SANDBOX_SCREEN_NETWORK === "internal") {
      const networkMode = info.HostConfig.NetworkMode;
      const address = networkMode
        ? info.NetworkSettings?.Networks?.[networkMode]?.IPAddress
        : undefined;
      if (address) return screenUrlFor(containerPort, address);
    }
    const hostPort = info.NetworkSettings?.Ports?.[`${containerPort}/tcp`]?.[0]?.HostPort;
    if (hostPort) return screenUrlFor(hostPort);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("computer screen port was not published");
}

async function setInteractiveScreen(
  container: Docker.Container,
  interactive: boolean,
  controlToken: string | undefined,
  layout: ReturnType<typeof screenPorts>,
) {
  const result = await runContainerCommand(container, [
    "bash",
    "-lc",
    interactiveScreenCommand(interactive, controlToken, layout),
  ]);
  if (result.code !== 0) throw new Error(result.stderr || "control screen failed to start");
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
  options: { workingDir?: string; env?: string[]; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeoutMs = options.timeoutMs;
  const completionMarker = timeoutMs
    ? `/tmp/rakazo-command-${randomUUID()}.completed-124`
    : undefined;
  const command =
    completionMarker && timeoutMs !== undefined
      ? sandboxTimeoutCommand(argv, timeoutMs, completionMarker)
      : argv;
  const exec = await container.exec({
    Cmd: command,
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
  const code = inspect.ExitCode ?? 0;
  const completedWithExit124 =
    code === 124 && completionMarker
      ? await consumeCompletionMarker(container, completionMarker)
      : false;
  const timedOut = sandboxCommandTimedOut(code, completedWithExit124);
  return {
    stdout: stripDockerStream(Buffer.concat(chunks)),
    stderr: timedOut ? `command timed out after ${timeoutMs} ms\n` : "",
    code,
  };
}

async function consumeCompletionMarker(container: Docker.Container, marker: string) {
  const result = await runContainerCommand(container, [
    "sh",
    "-c",
    'if [ -f "$0" ]; then rm -f "$0"; exit 0; fi; exit 1',
    marker,
  ]);
  return result.code === 0;
}

async function applyContainerActions(
  container: Docker.Container,
  actions: Array<z.infer<typeof computerActionSchema>>,
  display = ":1",
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
    JSON.stringify(actions.map((action) => containerActionStep(action, display))),
  ]);
  if (result.code !== 0) throw new Error(result.stderr || "computer action failed");
}

async function observeContainer(container: Docker.Container, display = ":1") {
  const command = [
    "set -e",
    `export DISPLAY=${display}`,
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
