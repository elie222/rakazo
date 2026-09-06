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
import { AlreadyExistsError, ModalClient, NotFoundError, type Sandbox } from "modal";
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

/** Modal runs the computer; durable homes remain in the configured AgentHomeStore. */
export class ModalSandboxProvider implements SandboxProvider {
  private readonly client: ModalClient;
  private readonly appName: string;
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
        multiScreen: false,
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
      if (error instanceof NotFoundError) {
        const missing = new Error("Cloud computer no longer exists");
        missing.name = "SandboxNotFoundError";
        throw missing;
      }
      throw error;
    });
    if ((await sandbox.getTags()).cadre_owner !== this.owner(computer.botId, ctx))
      throw new Error("Computer access denied");
    return sandbox;
  }
  async provision(
    req: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
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
      return ref(sandbox, false);
    };
    try {
      return await existing();
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
    const app = await this.client.apps.fromName(this.appName, { createIfMissing: true });
    const image = await this.client.images.fromId(this.options.imageId);
    try {
      return ref(
        await this.client.sandboxes.create(app, image, {
          name,
          tags: { cadre_owner: owner },
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
    } catch (e) {
      if (e instanceof AlreadyExistsError) return existing();
      throw e;
    }
  }
  private async rpc<T>(
    sandbox: Sandbox,
    request: Record<string, unknown>,
    timeoutMs = 30000,
  ): Promise<T> {
    const process = await sandbox.exec(["python3", "/opt/cadre/computer_rpc.py"], {
      timeoutMs,
      mode: "text",
    });
    // Modal limits each stdin message to 20 MiB. Browser profiles and other
    // portable files can be larger, especially after base64 encoding.
    const input = Buffer.from(JSON.stringify(request));
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
    for await (const event of this.execute(
      computer,
      {
        argv: [
          "bash",
          "-lc",
          "for i in {1..100}; do xdpyinfo -display :1 >/dev/null 2>&1 && exit 0; sleep 0.2; done; exit 1",
        ],
        timeoutMs: 25000,
      },
      ctx,
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
        { ...request, op: "exec", operationId, timeoutMs },
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
    if (request.interactive) await this.setScreenControl(computer, true, ctx, request.controlToken);
    const tunnel = (await sandbox.tunnels())[8080];
    if (!tunnel) throw new Error("Cloud desktop tunnel unavailable");
    const url = new URL("/embed.html", tunnel.url);
    url.searchParams.set("view_only", request.interactive ? "false" : "true");
    url.searchParams.set(
      "cadre_token",
      request.interactive ? request.controlToken! : this.viewToken(computer.botId, ctx),
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
    });
  }
  async releaseScreen(computer: ComputerRef, ctx: AdapterContext) {
    await this.setScreenControl(computer, false, ctx);
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
    });
  }
  async observe(computer: ComputerRef, ctx: AdapterContext) {
    return frame(await this.rpc<Frame>(await this.owned(computer, ctx), { op: "observe" }));
  }
  async act(computer: ComputerRef, request: ComputerActionRequest, ctx: AdapterContext) {
    const result = await this.rpc<{ completed: number; observation?: Frame }>(
      await this.owned(computer, ctx),
      { ...request, actions: boundedComputerActions(request.actions), op: "actions" },
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
    const pending = [""];
    const files: ComputerFileEntry[] = [];
    let total = 0;
    let count = 0;
    while (pending.length) {
      ctx.signal.throwIfAborted();
      const listings = await Promise.all(
        pending.splice(0, 8).map((directory) => this.listFiles(computer, directory, ctx)),
      );
      for (const entries of listings)
        for (const entry of entries) {
          if (shouldSkipPortableWorkspaceFile(entry.path)) continue;
          if (++count > 10000) throw new Error("Workspace has too many files");
          if (entry.kind === "dir") pending.push(entry.path);
          else {
            total += entry.size;
            if (total > 512 * 1024 * 1024)
              throw new Error("Workspace exceeds checkpoint size limit");
            files.push(entry);
          }
        }
    }
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
      const contents = await Promise.all(
        batch.map(async (entry) => ({
          path: entry.path,
          executable: entry.executable,
          content: await this.readFile(computer, entry.path, ctx),
        })),
      );
      for (const file of contents) yield file;
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    ctx: AdapterContext,
  ) {
    const sandbox = await this.owned(computer, ctx);
    let pending: Promise<unknown>[] = [];
    let bytes = 0;
    const flush = async () => {
      const results = await Promise.allSettled(pending);
      pending = [];
      bytes = 0;
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    };
    try {
      for await (const file of files) {
        ctx.signal.throwIfAborted();
        if (
          pending.length &&
          (pending.length >= 8 || bytes + file.content.length > 8 * 1024 * 1024)
        )
          await flush();
        bytes += file.content.length;
        const write = this.rpc(sandbox, {
          op: "write",
          path: file.path,
          executable: file.executable,
          content: Buffer.from(file.content).toString("base64"),
        });
        // Attach a handler immediately while the next remote file is downloading.
        void write.catch(() => undefined);
        pending.push(write);
      }
      await flush();
    } finally {
      await Promise.allSettled(pending);
    }
  }
  async snapshot(computer: ComputerRef, ctx: AdapterContext) {
    const image = await (await this.owned(computer, ctx)).snapshotFilesystem();
    return { id: image.imageId, createdAt: new Date().toISOString() };
  }
  async stop(computer: ComputerRef, ctx: AdapterContext) {
    await (await this.owned(computer, ctx)).terminate();
  }
  async destroy(computer: ComputerRef, ctx: AdapterContext) {
    await this.stop(computer, ctx);
  }
}
