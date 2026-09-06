import { createHash, createHmac, randomUUID } from "node:crypto";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { AlreadyExistsError, ModalClient, NotFoundError, type Sandbox } from "modal";
import { screenSessionKey } from "./computer-screens.js";
import { boundedComputerActions, computerObservation } from "./computer-support.js";
import { shouldSkipPortableWorkspaceFile } from "./computer-workspace.js";

export interface ModalSandboxOptions {
  imageId: string;
  screenSecret: string;
  appName?: string;
  tokenId?: string;
  tokenSecret?: string;
}
type Frame = { image: string; mimeType: "image/png"; width: number; height: number };
const frame = (value: Frame) => computerObservation(Buffer.from(value.image, "base64"), value);

/** Normalize only provider-reported terminal states, never shell or transport errors. */
function modalOperationError(error: unknown): unknown {
  if (
    error instanceof NotFoundError ||
    (error instanceof Error &&
      error.name === "ClientError" &&
      /^\/modal\.client\.ModalClient\/Sandbox\w+ FAILED_PRECONDITION: Sandbox has already finished with status \w+/.test(
        error.message,
      ))
  ) {
    const missing = new Error("Cloud computer no longer exists", { cause: error });
    missing.name = "SandboxNotFoundError";
    return missing;
  }
  return error;
}

function stoppedComputer(): Error {
  const error = new Error("Cloud computer has stopped");
  error.name = "SandboxNotFoundError";
  return error;
}

/** Modal runs the computer; durable homes remain in the configured AgentHomeStore. */
export class ModalSandboxProvider implements SandboxProvider {
  private readonly client: ModalClient;
  private readonly appName: string;
  private readonly protocols = new Map<string, boolean>();
  private readonly images = new Map<string, string>();
  constructor(
    private readonly options: ModalSandboxOptions,
    client?: ModalClient,
  ) {
    if (!options.imageId || options.screenSecret.length < 32)
      throw new Error("Modal image and a strong screen secret are required");
    this.client =
      client ?? new ModalClient({ tokenId: options.tokenId, tokenSecret: options.tokenSecret });
    this.appName = options.appName ?? "cadre-computers";
  }
  describe() {
    return {
      id: "modal",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: false,
        snapshots: true,
        takeover: true,
        persistentHome: false,
        multiScreen: true,
      },
    };
  }
  private owner(homeKey: string, ctx: AdapterContext) {
    // Computers can be shared by members of a space; never attach across spaces.
    return createHash("sha256")
      .update(JSON.stringify([ctx.spaceId, homeKey]))
      .digest("hex");
  }
  private viewToken(homeKey: string, ctx: AdapterContext) {
    return createHmac("sha256", this.options.screenSecret)
      .update(this.owner(homeKey, ctx))
      .digest("hex");
  }
  private async owned(computer: ComputerRef, ctx: AdapterContext) {
    if (computer.kind !== "modal") throw new Error("Incorrect computer provider");
    const sandbox = await this.client.sandboxes.fromId(computer.providerRef).catch((error) => {
      throw modalOperationError(error);
    });
    const tags = await sandbox.getTags().catch((error) => {
      throw modalOperationError(error);
    });
    if (tags.cadre_owner !== this.owner(computer.botId, ctx))
      throw new Error("Computer access denied");
    this.protocols.set(sandbox.sandboxId, tags.cadre_protocol === "2");
    this.images.set(sandbox.sandboxId, tags.cadre_image ?? "");
    return sandbox;
  }
  async provision(
    req: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
      workspaceSnapshot?: string;
    },
    ctx: AdapterContext,
  ): Promise<ComputerRef> {
    const owner = this.owner(req.botId, ctx);
    const ref = (sandbox: Sandbox, fresh: boolean): ComputerRef => ({
      id: sandbox.sandboxId,
      providerRef: sandbox.sandboxId,
      botId: req.botId,
      kind: "modal",
      fresh,
    });
    if (req.providerRef && req.providerKind === "modal") {
      try {
        const sandbox = await this.owned(
          { id: req.providerRef, providerRef: req.providerRef, botId: req.botId, kind: "modal" },
          ctx,
        );
        if ((await sandbox.poll()) === null) return ref(sandbox, false);
      } catch (e) {
        if (
          !(e instanceof NotFoundError) &&
          !(e instanceof Error && e.name === "SandboxNotFoundError")
        )
          throw e;
      }
    }
    const name = `cadre-${owner.slice(0, 48)}`;
    const existing = async () => {
      const sandbox = await this.client.sandboxes.fromName(this.appName, name);
      if ((await sandbox.getTags()).cadre_owner !== owner)
        throw new Error("Computer access denied");
      if ((await sandbox.poll()) !== null) throw new NotFoundError("Computer has stopped");
      return ref(sandbox, false);
    };
    try {
      return await existing();
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
    const app = await this.client.apps.fromName(this.appName, { createIfMissing: true });
    let imageId = this.options.imageId;
    if (req.workspaceSnapshot) {
      try {
        const snapshot = JSON.parse(req.workspaceSnapshot);
        if (
          snapshot.owner === owner &&
          snapshot.baseImage === this.options.imageId &&
          /^im-[A-Za-z0-9]+$/.test(snapshot.imageId) &&
          snapshot.expiresAt > Date.now()
        )
          imageId = snapshot.imageId;
      } catch {
        /* An invalid cache is never authority to restore another workspace. */
      }
    }
    const startedAt = Date.now();
    const create = async (selectedImage: string) => {
      const image = await this.client.images.fromId(selectedImage);
      const result = ref(
        await this.client.sandboxes.create(app, image, {
          name,
          tags: { cadre_owner: owner, cadre_protocol: "2", cadre_image: this.options.imageId },
          command: ["bash", "/opt/cadre/start.sh"],
          cpu: 2,
          memoryMiB: 4096,
          timeoutMs: 24 * 60 * 60 * 1000,
          encryptedPorts: [8080],
          env: {
            CADRE_SCREEN_VIEW_TOKEN: this.viewToken(req.botId, ctx),
            HOME: "/home/rakazo",
            DISPLAY: ":1",
          },
        }),
        true,
      );
      result.workspaceRestored = selectedImage !== this.options.imageId;
      getLogger().info("computer.provisioned", {
        durationMs: Date.now() - startedAt,
        restoredSnapshot: result.workspaceRestored,
      });
      return result;
    };
    try {
      return await create(imageId);
    } catch (e) {
      if (e instanceof AlreadyExistsError) return existing();
      if (imageId !== this.options.imageId && e instanceof NotFoundError)
        return create(this.options.imageId);
      throw e;
    }
  }
  private async rpc<T>(
    sandbox: Sandbox,
    request: Record<string, unknown>,
    timeoutMs = 30000,
  ): Promise<T> {
    const process = await sandbox
      .exec(["python3", "/opt/cadre/computer_rpc.py"], {
        timeoutMs,
        mode: "text",
      })
      .catch((error) => {
        throw modalOperationError(error);
      });
    // Modal limits each stdin message to 20 MiB. Browser profiles and other
    // portable files can be larger, especially after base64 encoding.
    // Untagged running images retain their primary-display protocol during rollout.
    const wireRequest = this.protocols.get(sandbox.sandboxId)
      ? request
      : { ...request, screenKey: undefined, screenLease: undefined };
    const input = Buffer.from(JSON.stringify(wireRequest));
    try {
      for (let offset = 0; offset < input.length; offset += 1024 * 1024) {
        await process.stdin.writeBytes(input.subarray(offset, offset + 1024 * 1024));
      }
    } finally {
      await process.stdin.close();
    }
    const [stdout, , code] = await Promise.all([
      process.stdout.readText(),
      process.stderr.readText(),
      process.wait(),
    ]);
    let result: T & { error?: string };
    try {
      result = JSON.parse(stdout);
    } catch {
      throw new Error("Computer returned an invalid response");
    }
    if (code !== 0 || result.error) throw new Error(result.error ?? "Computer operation failed");
    return result;
  }
  async prepare(computer: ComputerRef, ctx: AdapterContext) {
    if ((await (await this.owned(computer, ctx)).poll()) !== null) throw stoppedComputer();
    for await (const event of this.execute(
      computer,
      {
        argv: [
          "bash",
          "-lc",
          "for i in {1..100}; do xdpyinfo -display :1 >/dev/null 2>&1 && python3 -c 'import urllib.request; urllib.request.urlopen(\"http://127.0.0.1:8080/embed.html\", timeout=1).read(1)' >/dev/null 2>&1 && exit 0; sleep 0.2; done; exit 1",
        ],
        timeoutMs: 25000,
      },
      { ...ctx, botId: undefined, screenLeaseId: undefined },
    )) {
      if (event.type === "exit" && event.code !== 0)
        throw new Error("Cloud desktop did not become ready");
    }
  }
  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    ctx: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    ctx.signal.throwIfAborted();
    if (request.pty) throw new Error("Modal computer does not support PTY sessions");
    const sandbox = await this.owned(computer, ctx);
    const operationId = randomUUID();
    const timeoutMs = Math.min(Math.max(request.timeoutMs ?? 300000, 1), 3600000);
    let cancellation: Promise<unknown> | undefined;
    const cancel = () => {
      cancellation = this.rpc(sandbox, { op: "cancel", operationId }).catch(() => undefined);
    };
    ctx.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (ctx.signal.aborted) cancel();
      const result = await this.rpc<{ stdout: string; stderr: string; code: number }>(
        sandbox,
        {
          ...request,
          op: "exec",
          operationId,
          timeoutMs,
          screenKey: ctx.botId,
          screenLease: ctx.screenLeaseId,
        },
        timeoutMs + 15000,
      );
      ctx.signal.throwIfAborted();
      if (result.stdout) yield { type: "stdout", data: result.stdout };
      if (result.stderr) yield { type: "stderr", data: result.stderr };
      yield { type: "exit", code: result.code };
    } finally {
      ctx.signal.removeEventListener("abort", cancel);
      await cancellation;
    }
  }
  async connectScreen(computer: ComputerRef, request: ScreenRequest, ctx: AdapterContext) {
    if (request.view === "snapshot") {
      const observation = await this.observe(computer, ctx);
      return {
        url: `data:image/png;base64,${Buffer.from(observation.image).toString("base64")}`,
        mimeType: "image/png",
        close: async () => {},
      };
    }
    const sandbox = await this.owned(computer, ctx);
    if ((await sandbox.poll()) !== null) throw stoppedComputer();
    const screen = this.protocols.get(sandbox.sandboxId)
      ? await this.rpc<{ key: string }>(sandbox, {
          op: "resolveScreen",
          screenKey: screenSessionKey(ctx),
          screenLease: ctx.screenLeaseId,
        })
      : undefined;
    if (request.interactive) await this.setScreenControl(computer, true, ctx, request.controlToken);
    const tunnel = (
      await sandbox.tunnels().catch((error) => {
        throw modalOperationError(error);
      })
    )[8080];
    if (!tunnel) throw new Error("Cloud desktop tunnel unavailable");
    const url = new URL("/embed.html", tunnel.url);
    url.searchParams.set("view_only", request.interactive ? "false" : "true");
    if (screen) url.searchParams.set("screen", screen.key);
    url.searchParams.set(
      "cadre_token",
      request.interactive
        ? request.controlToken!
        : screen
          ? createHmac("sha256", this.viewToken(computer.botId, ctx))
              .update(screen.key)
              .digest("hex")
          : this.viewToken(computer.botId, ctx),
    );
    return {
      url: url.toString(),
      mimeType: "text/html",
      close: async () => {
        if (request.interactive)
          await this.setScreenControl(computer, false, ctx, request.controlToken);
      },
    };
  }
  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    ctx: AdapterContext,
    controlToken?: string,
  ) {
    if (interactive && !controlToken) throw new Error("Control lease required");
    await this.rpc(await this.owned(computer, ctx), {
      op: "screen",
      interactive,
      leaseId: controlToken ?? ctx.screenLeaseId,
      controlToken,
      screenKey: screenSessionKey(ctx),
    });
  }
  async releaseScreen(computer: ComputerRef, ctx: AdapterContext) {
    await this.setScreenControl(computer, false, ctx);
    const sandbox = await this.owned(computer, ctx);
    if (!this.protocols.get(sandbox.sandboxId)) return;
    await this.rpc(sandbox, {
      op: "releaseScreen",
      screenKey: screenSessionKey(ctx),
      screenLease: ctx.screenLeaseId,
    });
  }
  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    ctx: AdapterContext,
  ) {
    if (lease.holder !== "user" || lease.leaseId !== ctx.screenLeaseId)
      throw new Error("Control lease required");
    await this.rpc(await this.owned(computer, ctx), {
      op: "input",
      actions: [input],
      leaseId: lease.leaseId,
      screenKey: screenSessionKey(ctx),
    });
  }
  async observe(computer: ComputerRef, ctx: AdapterContext) {
    return frame(
      await this.rpc<Frame>(await this.owned(computer, ctx), {
        op: "observe",
        screenKey: screenSessionKey(ctx),
        screenLease: ctx.screenLeaseId,
      }),
    );
  }
  async act(computer: ComputerRef, request: ComputerActionRequest, ctx: AdapterContext) {
    const result = await this.rpc<{ completed: number; observation?: Frame }>(
      await this.owned(computer, ctx),
      {
        ...request,
        actions: boundedComputerActions(request.actions),
        op: "actions",
        screenKey: screenSessionKey(ctx),
        screenLease: ctx.screenLeaseId,
      },
      60000,
    );
    return {
      completed: result.completed,
      observation: result.observation ? frame(result.observation) : undefined,
    };
  }
  async listFiles(computer: ComputerRef, path: string, ctx: AdapterContext) {
    return this.rpc<ComputerFileEntry[]>(await this.owned(computer, ctx), { op: "list", path });
  }
  async readFile(
    computer: ComputerRef,
    path: string,
    ctx: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const result = await this.rpc<{ content: string }>(await this.owned(computer, ctx), {
      op: "read",
      path,
      ...options,
    });
    return Buffer.from(result.content, "base64");
  }
  async writeFile(computer: ComputerRef, file: PortableFile, ctx: AdapterContext) {
    await this.rpc(await this.owned(computer, ctx), {
      op: "write",
      path: file.path,
      executable: file.executable,
      content: Buffer.from(file.content).toString("base64"),
    });
  }
  async *exportWorkspace(computer: ComputerRef, ctx: AdapterContext): AsyncIterable<PortableFile> {
    const sandbox = await this.owned(computer, ctx);
    if (!this.protocols.get(sandbox.sandboxId)) {
      const pending = [""];
      let count = 0;
      let bytes = 0;
      while (pending.length) {
        ctx.signal.throwIfAborted();
        for (const entry of await this.rpc<ComputerFileEntry[]>(sandbox, {
          op: "list",
          path: pending.pop()!,
        })) {
          if (shouldSkipPortableWorkspaceFile(entry.path)) continue;
          if (++count > 10000) throw new Error("Workspace contains too many files");
          if (entry.kind === "dir") {
            pending.push(entry.path);
            continue;
          }
          bytes += entry.size;
          if (bytes > 512 * 1024 * 1024) throw new Error("Workspace exceeds transfer limit");
          const result = await this.rpc<{ content: string }>(sandbox, {
            op: "read",
            path: entry.path,
          });
          yield {
            path: entry.path,
            executable: entry.executable,
            content: Buffer.from(result.content, "base64"),
          };
        }
      }
      return;
    }
    const files = (await this.rpc<ComputerFileEntry[]>(sandbox, { op: "manifest" })).filter(
      (entry) => !shouldSkipPortableWorkspaceFile(entry.path),
    );
    // Bound both RPC concurrency and the bytes held before yielding to the home store.
    while (files.length) {
      ctx.signal.throwIfAborted();
      const batch = [files.shift()!];
      let bytes = batch[0]!.size;
      while (files.length && batch.length < 8 && bytes + files[0]!.size <= 8 * 1024 * 1024) {
        const entry = files.shift()!;
        batch.push(entry);
        bytes += entry.size;
      }
      const contents = await this.rpc<Array<{ content: string }>>(sandbox, {
        op: "readBatch",
        paths: batch.map((entry) => entry.path),
      });
      if (contents.length !== batch.length) throw new Error("Incomplete workspace batch");
      for (const [index, entry] of batch.entries())
        yield {
          path: entry.path,
          executable: entry.executable,
          content: Buffer.from(contents[index]!.content, "base64"),
        };
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    ctx: AdapterContext,
  ) {
    const sandbox = await this.owned(computer, ctx);
    if (!this.protocols.get(sandbox.sandboxId)) {
      for await (const file of files) {
        ctx.signal.throwIfAborted();
        await this.rpc(sandbox, {
          op: "write",
          path: file.path,
          executable: file.executable,
          content: Buffer.from(file.content).toString("base64"),
        });
      }
      return;
    }
    await this.rpc(sandbox, { op: "restoreBegin" });
    try {
      let batch: Array<{ path: string; executable?: boolean; content: string }> = [];
      let bytes = 0;
      const flush = async () => {
        if (!batch.length) return;
        await this.rpc(sandbox, { op: "writeBatch", files: batch });
        batch = [];
        bytes = 0;
      };
      for await (const file of files) {
        ctx.signal.throwIfAborted();
        if (batch.length && (batch.length >= 8 || bytes + file.content.length > 8 * 1024 * 1024))
          await flush();
        bytes += file.content.length;
        batch.push({
          path: file.path,
          executable: file.executable,
          content: Buffer.from(file.content).toString("base64"),
        });
      }
      await flush();
    } finally {
      await this.rpc(sandbox, { op: "restoreEnd" });
    }
  }

  async snapshot(computer: ComputerRef, ctx: AdapterContext) {
    const image = await (await this.owned(computer, ctx)).snapshotFilesystem({
      ttlMs: 24 * 60 * 60 * 1000,
    });
    return { id: image.imageId, createdAt: new Date().toISOString() };
  }
  async snapshotWorkspace(computer: ComputerRef, ctx: AdapterContext) {
    const sandbox = await this.owned(computer, ctx);
    if (
      !this.protocols.get(sandbox.sandboxId) ||
      this.images.get(sandbox.sandboxId) !== this.options.imageId
    )
      throw new Error("Computer image update awaits idle restart");
    const snapshot = await this.snapshot(computer, ctx);
    return JSON.stringify({
      imageId: snapshot.id,
      baseImage: this.options.imageId,
      owner: this.owner(computer.botId, ctx),
      expiresAt: Date.now() + 23 * 60 * 60 * 1000,
    });
  }
  async stop(computer: ComputerRef, ctx: AdapterContext) {
    const sandbox = await this.owned(computer, ctx);
    await sandbox.terminate();
    await sandbox.wait();
    this.protocols.delete(sandbox.sandboxId);
    this.images.delete(sandbox.sandboxId);
  }
  async destroy(computer: ComputerRef, ctx: AdapterContext) {
    await this.stop(computer, ctx);
  }
}
