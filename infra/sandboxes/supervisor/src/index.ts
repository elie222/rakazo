import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { boundedSandboxCommandTimeoutMs, resolveSupervisorToken } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import Docker from "dockerode";
import { Hono } from "hono";
import { z } from "zod";
import {
  COMPUTER_GID,
  COMPUTER_IMAGE,
  COMPUTER_UID,
  COMPUTER_USER,
  computerNetworkNameFor,
  computerNetworkNamesForCleanup,
  containerCreateOptions,
  containerNameFor,
  hostComputerUser,
  legacyNetworkOwnedSolelyBy,
  resolveComputerControlEndpoint,
  resolveScreenNetworkMode,
  resolveScreenPublishTarget,
  resolveTeamScreenLimit,
  SCREEN_HOST,
  screenPorts,
  screenUrlFor,
  xdotoolCommand,
} from "./computer-spec.js";
import { assertComputerHomeWritable } from "./home-ownership.js";
import {
  assertRequestIdentity,
  attemptComputerControl,
  browserProfilePathForScreen,
  ComputerControlUnavailableError,
  clearComputerScreenRegistry,
  computerActionSchema,
  computerControlTimeoutMs,
  containerActionSteps,
  demuxDockerStream,
  ensureScreenCommand,
  hasComputerIdentity,
  hasValidBearerToken,
  interactiveScreenCommand,
  isComputerControlUnavailable,
  nextScreenIndex,
  normalizeWorkspaceRelative,
  parseObservation,
  preferComputerControl,
  releaseAssignedScreen,
  resetManagedScreensCommand,
  type ScreenAssignment,
  sandboxCommandTimedOut,
  sandboxTimeoutCommand,
  screenReleaseStopCommand,
  shouldReplayComputerActions,
  stopExtraScreenCommand,
  syncSharedBrowserProfileCommand,
  teardownReleasedScreen,
  toSandboxInput,
  withKeyedLock,
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
const screenNetworkMode = resolveScreenNetworkMode(process.env.SANDBOX_SCREEN_NETWORK);
const teamScreenLimit = resolveTeamScreenLimit();
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
      spaceId: z.string().min(1),
    })
    .parse(await c.req.json());
  try {
    assertRequestIdentity(c.req.header("x-rakazo-bot-id"), c.req.header("x-rakazo-space-id"), {
      botId: body.botId,
      spaceId: body.spaceId,
    });
    return await withBotLifecycleLock(body.botId, async () => {
      await ensureComputerImage();
      const runtimeInfo = await inspectSupervisorContainer();
      const networkMode = await computerNetworkName(body.botId, runtimeInfo);
      const serviceHomePath = path.resolve(body.homePath);
      assertBotHomePath(serviceHomePath, body.botId);
      const hostUid = process.getuid?.();
      const hostGid = process.getgid?.();
      // The API normally creates the home. A non-root standalone supervisor may
      // do so as the same user, but a root supervisor must never create or chown
      // user-controlled paths at runtime; Compose data-init handles legacy data.
      if (hostUid !== 0) await mkdir(serviceHomePath, { recursive: true });
      const homePath = hostHomePath(serviceHomePath, runtimeInfo);
      const computerUser = runtimeInfo ? COMPUTER_USER : hostComputerUser(hostUid, hostGid);
      const existing = await findBotContainer(body.botId, body.spaceId);
      if (existing) {
        const info = await existing.inspect();
        const desired = await docker.getImage(COMPUTER_IMAGE).inspect();
        if (
          info.Image === desired.Id &&
          (!networkMode || info.HostConfig.NetworkMode === networkMode) &&
          info.Config.User === computerUser
        ) {
          if (!info.State.Running) await existing.start();
          const screenUrl = await publishedScreenUrl(
            existing,
            info.State.Running ? info : undefined,
          );
          return c.json({
            id: existing.id,
            image: COMPUTER_IMAGE,
            screenUrl,
            resumed: true,
          });
        }
      }
      // Existing containers with the current image already use the selected user.
      // Before replacing or creating a container, validate its home without
      // privileged filesystem mutations that could escape via concurrent renames.
      // Match hostComputerUser(): missing/root host identity falls back to 1000:1000.
      const effectiveUid =
        runtimeInfo || hostUid === undefined || hostGid === undefined || hostUid === 0
          ? COMPUTER_UID
          : hostUid;
      const effectiveGid =
        runtimeInfo || hostUid === undefined || hostGid === undefined || hostUid === 0
          ? COMPUTER_GID
          : hostGid;
      await assertComputerHomeWritable(serviceHomePath, effectiveUid, effectiveGid);
      if (existing) {
        await existing.remove({ force: true }).catch(() => undefined);
      }
      const name = containerNameFor(body.botId);
      const container = await docker.createContainer(
        containerCreateOptions({
          name,
          image: COMPUTER_IMAGE,
          botId: body.botId,
          spaceId: body.spaceId,
          homePath,
          user: computerUser,
          networkMode,
          controlToken: randomUUID(),
        }),
      );
      await container.start();
      const screenUrl = await publishedScreenUrl(container);
      return c.json({
        id: container.id,
        image: COMPUTER_IMAGE,
        screenUrl,
        resumed: false,
      });
    });
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
      c.req.header("x-rakazo-space-id"),
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
      c.req.header("x-rakazo-space-id"),
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
    const { container, info, layout, browserProfile } = await managedScreen(
      c.req.param("id"),
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-space-id"),
      c.req.header("x-rakazo-screen-id"),
      c.req.header("x-rakazo-screen-lease-id"),
    );
    const control = computerControlEndpoint(info);
    const observation = await preferComputerControl(
      control
        ? async () => {
            const result = await controlDesktop(
              control,
              [],
              layout.display,
              browserProfile,
              true,
              0,
            );
            if (!result.observation) throw new Error("computer control returned no observation");
            return result.observation;
          }
        : undefined,
      () => observeContainer(container, layout.display),
    );
    return c.json(observation);
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
    const { container, info, layout, browserProfile } = await managedScreen(
      c.req.param("id"),
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-space-id"),
      c.req.header("x-rakazo-screen-id"),
      c.req.header("x-rakazo-screen-lease-id"),
    );
    const control = computerControlEndpoint(info);
    const attempt = await attemptComputerControl(
      control
        ? () =>
            controlDesktop(
              control,
              body.actions,
              layout.display,
              browserProfile,
              body.observe !== false,
              body.settleMs ?? 0,
            )
        : undefined,
    );
    if (attempt.status === "failed") throw attempt.error;
    const controlResult = attempt.status === "ok" ? attempt.value : undefined;
    if (shouldReplayComputerActions(attempt) && body.actions.length)
      await applyContainerActions(container, body.actions, layout.display, browserProfile);
    if (shouldReplayComputerActions(attempt) && body.settleMs)
      await new Promise((resolve) => setTimeout(resolve, body.settleMs));
    return c.json({
      completed: controlResult?.completed ?? body.actions.length,
      ...(body.observe === false
        ? {}
        : {
            observation:
              controlResult?.observation ?? (await observeContainer(container, layout.display)),
          }),
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
      c.req.header("x-rakazo-space-id"),
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
      c.req.header("x-rakazo-space-id"),
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
      c.req.header("x-rakazo-space-id"),
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
    const id = c.req.param("id");
    const botId = c.req.header("x-rakazo-bot-id");
    const spaceId = c.req.header("x-rakazo-space-id");
    const screenId = c.req.header("x-rakazo-screen-id");
    const screenLeaseId = c.req.header("x-rakazo-screen-lease-id");
    const { container, info } = await managedContainer(id, botId, spaceId);
    const { layout } = await withComputerScreenLock(id, async () => {
      const screen = await ensureManagedScreen(id, container, info, botId, screenId, screenLeaseId);
      const controlChanged =
        body.interactive || body.revokeControl !== false
          ? await setInteractiveScreen(
              container,
              body.interactive,
              body.controlToken,
              screen.layout,
            )
          : false;
      // Releasing an explicit user-control lease is the authoritative profile
      // checkpoint: persist sign-ins, then restart the isolated browser from
      // that shared snapshot so a resumed bot keeps the same browser state.
      if (
        !body.interactive &&
        body.controlToken &&
        body.revokeControl !== false &&
        controlChanged
      ) {
        const synced = await runContainerCommand(container, [
          "bash",
          "-lc",
          syncSharedBrowserProfileCommand(screen.screenKey, true),
        ]);
        if (synced.code !== 0) {
          throw new Error(synced.stderr || "shared browser profile failed to sync");
        }
        const restarted = await runContainerCommand(container, [
          "bash",
          "-lc",
          ensureScreenCommand(screen.index, screen.screenKey),
        ]);
        if (restarted.code !== 0) {
          throw new Error(restarted.stderr || "computer browser failed to restart");
        }
      }
      return screen;
    });
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
      c.req.header("x-rakazo-space-id"),
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
    const id = c.req.param("id");
    const { container } = await managedContainer(
      id,
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-space-id"),
    );
    const screenId = c.req.header("x-rakazo-screen-id") || c.req.header("x-rakazo-bot-id") || id;
    const cancelRunWork = c.req.header("x-rakazo-cancel-run-work") === "1";
    const authoritativeBrowserState = c.req.header("x-rakazo-authoritative-browser-state") === "1";
    const screenLeaseId = c.req.header("x-rakazo-screen-lease-id");
    await withComputerScreenLock(id, async () => {
      const assigned = computerScreens.get(id);
      const index = assigned ? releaseAssignedScreen(assigned, screenId, screenLeaseId) : undefined;
      const stop = screenReleaseStopCommand(index, {
        hasRegistry: Boolean(assigned),
        cancelRunWork,
        screenId,
        authoritativeBrowserState,
      });
      if (assigned && index !== undefined) {
        await teardownReleasedScreen(assigned, screenId, index, () =>
          runContainerCommand(container, ["bash", "-lc", stop]),
        );
      } else if (stop) {
        const result = await runContainerCommand(container, ["bash", "-lc", stop]);
        if (result.code !== 0) {
          throw new Error(result.stderr || "computer screen failed to stop");
        }
      }
      if (assigned?.size === 0) computerScreens.delete(id);
    });
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
      c.req.header("x-rakazo-space-id"),
    );
    await withComputerScreenLock(id, async () => {
      await container.stop().catch(() => undefined);
      clearComputerScreenRegistry(computerScreens, id);
    });
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "computer not found" }, 404);
  }
});

app.delete("/computers/:id", async (c) => {
  const id = c.req.param("id");
  const botId = c.req.header("x-rakazo-bot-id");
  try {
    if (!botId) throw new Error("missing computer identity");
    return await withBotLifecycleLock(botId, async () => {
      const { container } = await managedContainer(id, botId, c.req.header("x-rakazo-space-id"));
      await withComputerScreenLock(id, async () => {
        await container.remove({ force: true }).catch(() => undefined);
        clearComputerScreenRegistry(computerScreens, id);
      });
      if (screenNetworkMode !== "internal") {
        await removeBotNetwork(botId);
      }
      return c.json({ ok: true });
    });
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
            "control.py",
            "xcapture.c",
            "rakazo-browser",
            "rakazo-browser.desktop",
            "embed.html",
            "clipboard-bridge.js",
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

async function findBotContainer(botId: string, spaceId: string) {
  const listed = await docker.listContainers({
    all: true,
    filters: {
      // Space IDs were preserved when workspaces became Spaces. Search by the
      // stable bot label, then validate either generation of the Space label.
      label: [`rakazo.botId=${botId}`],
    },
  });
  for (const item of listed) {
    const container = docker.getContainer(item.Id);
    const info = await container.inspect();
    if (isRakazoContainer(info, botId, spaceId)) return container;
  }
  return undefined;
}

async function managedContainer(id: string, botId?: string, spaceId?: string) {
  if (!botId || !spaceId) throw new Error("missing computer identity");
  const container = docker.getContainer(id);
  const info = await container.inspect();
  if (!isRakazoContainer(info, botId, spaceId)) throw new Error("computer identity mismatch");
  return { container, info };
}

async function managedScreen(
  id: string,
  botId: string | undefined,
  spaceId: string | undefined,
  screenId: string | undefined,
  screenLeaseId: string | undefined,
) {
  const { container, info } = await managedContainer(id, botId, spaceId);
  return withComputerScreenLock(id, () =>
    ensureManagedScreen(id, container, info, botId, screenId, screenLeaseId),
  );
}

async function ensureManagedScreen(
  id: string,
  container: Docker.Container,
  info: Docker.ContainerInspectInfo,
  botId: string | undefined,
  screenId: string | undefined,
  screenLeaseId: string | undefined,
) {
  let assigned = computerScreens.get(id);
  if (!assigned) {
    const reset = await runContainerCommand(container, [
      "bash",
      "-lc",
      resetManagedScreensCommand(),
    ]);
    if (reset.code !== 0) throw new Error(reset.stderr || "computer screens failed to reset");
    assigned = new Map();
    computerScreens.set(id, assigned);
  }
  const screenKey = screenId || botId || id;
  const index = nextScreenIndex(assigned, screenKey, screenLeaseId, teamScreenLimit);
  const layout = screenPorts(index);
  const ensured = await runContainerCommand(container, [
    "bash",
    "-lc",
    ensureScreenCommand(index, screenKey),
  ]);
  if (ensured.code !== 0) {
    releaseAssignedScreen(assigned, screenKey);
    await teardownReleasedScreen(assigned, screenKey, index, () =>
      runContainerCommand(container, ["bash", "-lc", stopExtraScreenCommand(index, screenKey)]),
    );
    if (assigned.size === 0) computerScreens.delete(id);
    throw new Error(ensured.stderr || `computer screen ${layout.display} failed to start`);
  }
  return {
    container,
    info,
    layout,
    index,
    screenKey,
    browserProfile: browserProfilePathForScreen(screenKey),
  };
}

function isRakazoContainer(info: Docker.ContainerInspectInfo, botId: string, spaceId: string) {
  const labels = info.Config.Labels ?? {};
  const managed = labels["rakazo.managed"] === "true" || info.Config.Image === COMPUTER_IMAGE;
  return managed && hasComputerIdentity(labels, botId, spaceId);
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

function computerControlEndpoint(info: Docker.ContainerInspectInfo) {
  const token = info.Config.Env?.find((value) =>
    value.startsWith("RAKAZO_COMPUTER_CONTROL_TOKEN="),
  )?.slice("RAKAZO_COMPUTER_CONTROL_TOKEN=".length);
  return resolveComputerControlEndpoint({
    token,
    networkMode: info.HostConfig.NetworkMode,
    networks: info.NetworkSettings?.Networks,
  });
}

async function controlDesktop(
  endpoint: { url: string; token: string },
  actions: Array<z.infer<typeof computerActionSchema>>,
  display: string,
  browserProfile: string,
  observe: boolean,
  settleMs: number,
) {
  let response: Response;
  try {
    response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        steps: containerActionSteps(actions, display, browserProfile),
        display,
        observe,
        settleMs,
      }),
      signal: AbortSignal.timeout(computerControlTimeoutMs(actions, settleMs)),
    });
  } catch (error) {
    if (isComputerControlUnavailable(error)) {
      throw new ComputerControlUnavailableError(
        error instanceof Error ? error.message : "computer control unavailable",
      );
    }
    throw error;
  }
  const payload = (await response.json()) as {
    completed?: unknown;
    observation?: unknown;
    error?: unknown;
  };
  if (!response.ok) throw new Error(String(payload.error ?? "computer control failed"));
  if (typeof payload.completed !== "number")
    throw new Error("computer control returned no completion count");
  return {
    completed: payload.completed,
    ...(payload.observation ? { observation: payload.observation } : {}),
  };
}
const SCREEN_READY_TIMEOUT_MS = 45_000;

// Docker publishes a container's port mapping (or assigns its internal IP)
// almost immediately on start, well before the process inside the container
// is actually listening on it (Xvfb, the browser, x11vnc, then websockify
// all start in sequence — see infra/sandboxes/computer/start.sh). Returning
// the URL as soon as the mapping exists lets the frontend iframe race the
// container's own boot sequence and hit "socket hang up" on first load.
//
// A bare TCP connect isn't a strong enough signal either: it only proves the
// port is accepting connections, not that websockify is actually up and
// serving — the same race can still slip through between "port open" and
// "websockify ready" (e.g. right after setInteractiveScreen starts a new
// x11vnc/websockify pair on the control port for a takeover). An HTTP GET
// against the same embed.html path the browser will load only succeeds once
// websockify itself is answering requests, closing that gap too.
export async function waitForScreenReady(host: string, port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  do {
    const ready = await new Promise<boolean>((resolve) => {
      const req = http.get({ host, port, path: "/embed.html", timeout: 1_500 }, (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolve(status >= 200 && status < 300);
      });
      req.once("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.once("error", () => resolve(false));
    });
    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  } while (Date.now() < deadline);
  return false;
}

async function publishedScreenUrl(
  container: Docker.Container,
  initialInfo?: Docker.ContainerInspectInfo,
  containerPort = "6080",
) {
  for (let i = 0; i < 30; i += 1) {
    const info = i === 0 && initialInfo ? initialInfo : await container.inspect();
    if (screenNetworkMode === "isolated") {
      const runtime = supervisorInfo ?? (await inspectSupervisorContainer());
      const networkName = info.HostConfig.NetworkMode;
      if (runtime && networkName) await connectComposeScreenPeers(networkName, runtime);
    }
    const target = resolveScreenPublishTarget({
      screenNetwork: screenNetworkMode,
      networkMode: info.HostConfig.NetworkMode,
      networks: info.NetworkSettings?.Networks,
      hostPort: info.NetworkSettings?.Ports?.[`${containerPort}/tcp`]?.[0]?.HostPort,
      containerPort,
      screenHost: SCREEN_HOST,
    });
    if (target) {
      const ready = await waitForScreenReady(
        target.host,
        Number(target.port),
        SCREEN_READY_TIMEOUT_MS,
      );
      if (!ready) throw new Error("computer screen did not become ready in time");
      return screenUrlFor(target.port, target.host);
    }
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
  return interactive || !controlToken || result.stdout.includes("RAKAZO_CONTROL_RELEASED\n");
}

// Each bot's computer gets its own Docker network so containers cannot reach
// one another (Docker's default "bridge" network allows any container to
// dial any other container's exposed ports, which would let one bot's
// computer reach another bot's desktop/VNC endpoint with no authentication).
async function computerNetworkName(botId: string, info: Docker.ContainerInspectInfo | undefined) {
  if (screenNetworkMode === "internal") {
    // The supervisor itself runs in this shared network in that topology and
    // needs to address child containers by their in-network IP, so children
    // stay on the supervisor's network rather than an isolated one.
    return info ? Object.keys(info.NetworkSettings.Networks)[0] : undefined;
  }
  if (screenNetworkMode === "isolated" && !info) {
    throw new Error("isolated Compose screens require a containerized supervisor");
  }
  return ensureBotNetwork(botId);
}

async function connectComposeScreenPeers(networkName: string, info: Docker.ContainerInspectInfo) {
  const peerIds = new Set([info.Id]);
  const project = info.Config.Labels?.["com.docker.compose.project"];
  if (project) {
    const webContainers = await docker.listContainers({
      all: true,
      filters: {
        label: [`com.docker.compose.project=${project}`, "com.docker.compose.service=web"],
      },
    });
    for (const container of webContainers) peerIds.add(container.Id);
  }
  const network = docker.getNetwork(networkName);
  const networkInfo = await network.inspect();
  const connectedIds = new Set(Object.keys(networkInfo.Containers ?? {}));
  await Promise.all(
    [...peerIds]
      .filter((containerId) => !connectedIds.has(containerId))
      .map((containerId) =>
        network.connect({ Container: containerId }).catch((error) => {
          if (!/already exists|already connected/i.test(String(error))) throw error;
        }),
      ),
  );
}

async function ensureBotNetwork(botId: string) {
  const name = computerNetworkNameFor(botId);
  await docker
    .createNetwork({ Name: name, Driver: "bridge", CheckDuplicate: true })
    .catch((error) => {
      // Existing networks and concurrent provision requests are both safe.
      if (!/already exists/i.test(String(error))) throw error;
    });
  return name;
}

async function removeBotNetwork(botId: string) {
  const currentName = computerNetworkNameFor(botId);
  for (const name of computerNetworkNamesForCleanup(botId)) {
    const network = docker.getNetwork(name);
    const info = await network.inspect().catch(() => undefined);
    if (!info) continue;
    const containerIds = Object.keys(info.Containers ?? {});
    if (name !== currentName) {
      const owners: Array<string | undefined> = [];
      for (const containerId of containerIds) {
        const labels =
          (
            await docker
              .getContainer(containerId)
              .inspect()
              .catch(() => undefined)
          )?.Config.Labels ?? {};
        const owner = labels["rakazo.botId"];
        owners.push(owner);
        if (owner === botId) {
          await network.disconnect({ Container: containerId, Force: true }).catch(() => undefined);
        }
      }
      if (!legacyNetworkOwnedSolelyBy(botId, owners)) continue;
    }
    const remaining = await network.inspect().catch(() => undefined);
    for (const containerId of Object.keys(remaining?.Containers ?? {})) {
      await network.disconnect({ Container: containerId, Force: true }).catch(() => undefined);
    }
    await network.remove().catch(() => undefined);
  }
}

const botLifecycleLocks = new Map<string, Promise<unknown>>();
const computerScreenLocks = new Map<string, Promise<unknown>>();

// Serialize create/delete for one bot so DELETE cannot remove a per-bot network
// while POST still needs it between ensureBotNetwork and container attach.
async function withBotLifecycleLock<T>(botId: string, task: () => Promise<T>): Promise<T> {
  return withKeyedLock(botLifecycleLocks, botId, task);
}

// Serialize screen claim/release/cancel for one computer so a restart-orphan
// cancel cannot race a replacement claim and kill the newer Chromium session.
async function withComputerScreenLock<T>(computerId: string, task: () => Promise<T>): Promise<T> {
  return withKeyedLock(computerScreenLocks, computerId, task);
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
  const output = demuxDockerStream(Buffer.concat(chunks));
  return {
    stdout: output.stdout,
    stderr: timedOut
      ? `${output.stderr}${output.stderr.endsWith("\n") || output.stderr === "" ? "" : "\n"}command timed out after ${timeoutMs} ms\n`
      : output.stderr,
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
  browserProfile?: string,
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
    JSON.stringify(containerActionSteps(actions, display, browserProfile)),
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
    const output = demuxDockerStream(Buffer.concat(chunks));
    throw new Error(output.stderr || output.stdout || "file write failed");
  }
}
