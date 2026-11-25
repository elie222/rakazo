import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import type {
  AdapterContext,
  ComputerRef,
  ScreenRequest,
  TerminalRequest,
  UnreferencedMachine,
  UnreferencedMachineRecords,
} from "@rakazo/adapter-kit";
import { SandboxUnavailableError } from "@rakazo/adapter-kit";
import { deadlineSignal, pollUntil } from "@rakazo/core";
import { COMPUTER_CACHE_ENV, shellQuote } from "@rakazo/core/node/desktop-runtime";
import { getLogger } from "@rakazo/logging";
import type { RawExecEvent } from "../../../computers/sandbox/exec-computer.js";
import { RawExecChannel } from "../../../computers/sandbox/exec-computer.js";
import { ImageComputerSandbox } from "../../../computers/sandbox/image-computer-sandbox.js";
import {
  deleteUnreferencedMachine,
  recordUnreferencedMachine,
} from "../../../computers/sandbox/sandbox-cleanup.js";
import { sandboxNotFoundError } from "../../../computers/sandbox/sandbox-errors.js";
import { BOOT_SCRIPT, EXEC_WRAPPER } from "./exe-boot.js";
import type { ExeClient, ExeVm } from "./exe-client.js";

// Pin a release tag or digest with EXE_SANDBOX_COMPUTER_IMAGE in production.
const DEFAULT_COMPUTER_IMAGE = "ghcr.io/elie222/rakazo/computer:edge";
const DEFAULT_READY_TIMEOUT_MS = 180_000;
/** A new VM pulls the computer image first. */
const CREATE_TIMEOUT_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const BOOT_TIMEOUT_MS = 120_000;
/** VM tokens outlive the screen capability that carries them, which lasts an hour. */
const SCREEN_TOKEN_MS = 2 * 60 * 60_000;
const COMMENT_PREFIX = "rakazo computer for bot ";
const NAME_PREFIX = "rakazo-";

export interface ExeSandboxOptions {
  /**
   * A tag for every computer VM. Optional: a key restricted to a tag puts its tag on the VMs it
   * creates anyway, and the provider recognizes its VMs by name and comment.
   */
  tag?: string;
  computerImage?: string;
  cpus?: number;
  memory?: string;
  readyTimeoutMs?: number;
  unreferencedMachines?: UnreferencedMachineRecords;
}

/**
 * Computers on exe.dev: each one is a standalone VM booted from the published computer image,
 * reached through exe.dev's HTTPS API for commands and its HTTPS proxy, with a VM token, for
 * screens.
 * VMs are deleted when their computer stops; the saved workspace is the persistence.
 */
export class ExeSandboxProvider extends ImageComputerSandbox {
  private readonly tag: string | undefined;
  private readonly computerImage: string;
  private readonly cpus: number | undefined;
  private readonly memory: string | undefined;
  private readonly readyTimeoutMs: number;
  private readonly machines: UnreferencedMachineRecords | undefined;
  private readonly client: ExeClient;
  /** Each VM's HTTPS host name, once known. */
  private readonly hosts = new Map<string, string>();

  constructor(options: ExeSandboxOptions, client: ExeClient) {
    super("exe", "exe.dev");
    this.tag = options.tag?.trim() || undefined;
    if (this.tag && !/^[a-z0-9][a-z0-9-]*$/.test(this.tag)) {
      throw new Error("EXE_SANDBOX_TAG may use only lower-case letters, digits and dashes");
    }
    if (options.cpus !== undefined && !(Number.isSafeInteger(options.cpus) && options.cpus > 0)) {
      throw new Error("EXE_SANDBOX_CPUS must be a whole number of CPUs");
    }
    this.computerImage = options.computerImage?.trim() || DEFAULT_COMPUTER_IMAGE;
    this.cpus = options.cpus;
    this.memory = options.memory?.trim() || undefined;
    this.readyTimeoutMs =
      Number.isSafeInteger(options.readyTimeoutMs) && (options.readyTimeoutMs ?? 0) > 0
        ? options.readyTimeoutMs!
        : DEFAULT_READY_TIMEOUT_MS;
    this.machines = options.unreferencedMachines;
    this.client = client;
  }

  /** Standalone VMs bill by the hour while they exist, and a stopped computer has none. */
  billsWhileRunning(): boolean {
    return true;
  }

  async provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
    },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const { signal } = context;
    signal.throwIfAborted();
    if (request.providerKind === "exe" && request.providerRef) {
      const name = request.providerRef;
      const existing = await this.vm(name, signal);
      if (existing) this.assertOwner(existing, name, request.botId);
      if (existing?.status === "running") {
        try {
          // A VM that restarted runs the image's command as root again until it is booted.
          await this.boot(name, signal);
          await this.waitForReady(name, request.botId, context);
          return { id: name, botId: request.botId, kind: "exe", providerRef: name, fresh: false };
        } catch (error) {
          signal.throwIfAborted();
          // Its computer died or never came back: a fresh VM gets the saved workspace instead.
          getLogger().warn("replace an exe.dev computer that did not start", { error, vm: name });
        }
      }
      if (existing) await this.discard(name, request.botId);
    }
    await this.removeOrphans(request.botId, request.providerRef, signal);
    // VM names are global on exe.dev, and a new one for every start means a later start never
    // adopts a VM an abandoned one created.
    const name = `${NAME_PREFIX}${randomBytes(8).toString("hex")}`;
    const machine = { provider: "exe", machineId: name, homeKey: request.botId };
    await recordUnreferencedMachine(this.machines, machine);
    try {
      await this.create(name, request.botId, signal);
      await this.boot(name, signal);
      await this.waitForReady(name, request.botId, context);
    } catch (error) {
      await this.discard(name, request.botId);
      throw error;
    }
    return { id: name, botId: request.botId, kind: "exe", providerRef: name, fresh: true };
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    if (computer.kind !== "exe") return false;
    return (await this.vm(vmName(computer), context.signal))?.status === "running";
  }

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    await this.removeOwned(vmName(computer), computer.botId);
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    await this.removeOwned(vmName(computer), computer.botId);
  }

  async deleteMachine(machine: UnreferencedMachine, signal: AbortSignal): Promise<void> {
    await this.remove(machine.machineId, signal);
  }

  override async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ) {
    const session = await super.connectScreen(computer, request, context);
    return { ...session, headers: await this.proxyHeaders(computer, context) };
  }

  override async connectTerminal(
    computer: ComputerRef,
    request: TerminalRequest,
    context: AdapterContext,
  ) {
    const session = await super.connectTerminal(computer, request, context);
    return { ...session, headers: await this.proxyHeaders(computer, context) };
  }

  /** exe.dev's proxy serves the VM's ports over HTTPS and lets in only the account's tokens. */
  protected override async screenOrigin(
    computer: ComputerRef,
    port: number,
    context: AdapterContext,
  ): Promise<string> {
    return `https://${await this.screenAddress(computer, context)}:${port}`;
  }

  protected async screenAddress(computer: ComputerRef, { signal }: AdapterContext) {
    return this.host(vmName(computer), signal);
  }

  /** The proxy reaches the VM over its network interface. */
  protected async relayBindHost() {
    return "0.0.0.0";
  }

  protected override async screenControlFailure(computer: ComputerRef, error: unknown) {
    return this.goneOr(vmName(computer), error);
  }

  protected async *execRaw(
    computer: ComputerRef,
    command: string[],
    signal: AbortSignal,
    timeoutMs: number,
    stdin?: Readable,
  ): AsyncIterable<RawExecEvent> {
    // The API runs commands without a terminal; the computer's terminal goes through its screen
    // gateway instead.
    const name = vmName(computer);
    const stop = new AbortController();
    const channel = new RawExecChannel(signal, timeoutMs, () => stop.abort());
    const start = async () => {
      const code = await this.client.run(
        name,
        `${EXEC_WRAPPER} ${command.map(shellQuote).join(" ")}`,
        {
          stdin,
          signal: stop.signal,
          stdout: (data) => channel.push({ type: "stdout", data }),
          stderr: (data) => channel.push({ type: "stderr", data }),
        },
      );
      channel.finish(code);
    };
    try {
      start().catch((error: unknown) => channel.fail(error));
      yield* channel.drain();
      if (channel.failure) throw await this.goneOr(name, channel.failure);
    } finally {
      channel.close();
      stdin?.destroy();
      stop.abort();
    }
  }

  /** Stops the image's command that exe.dev started as root and starts it as the image user. */
  private async boot(name: string, signal: AbortSignal): Promise<void> {
    const environment = Object.entries({ ...COMPUTER_CACHE_ENV, VNC_RESOLUTION: "1280x800" })
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    const output: Buffer[] = [];
    const code = await this.client.run(
      name,
      `RAKAZO_EXTRA_ENV=${shellQuote(environment)} bash -s`,
      {
        stdin: [Buffer.from(BOOT_SCRIPT)],
        signal: deadlineSignal(BOOT_TIMEOUT_MS, signal),
        stdout: (data) => output.push(data),
        stderr: (data) => output.push(data),
      },
    );
    if (code !== 0) {
      throw new Error(
        `exe.dev computer ${name} did not start: ${Buffer.concat(output).toString("utf8").trim()}`,
      );
    }
  }

  private async waitForReady(name: string, botId: string, context: AdapterContext) {
    const computer: ComputerRef = { id: name, botId, kind: "exe", providerRef: name };
    await pollUntil(() => this.screenGatewayUp(computer, context), {
      intervalMs: 500,
      timeoutMs: this.readyTimeoutMs,
      signal: context.signal,
      onTimeout: () => {
        throw new SandboxUnavailableError({
          cause: new Error(
            `exe.dev computer ${name} did not become ready within ${this.readyTimeoutMs} ms`,
          ),
        });
      },
    });
  }

  private async create(name: string, botId: string, signal: AbortSignal): Promise<void> {
    const created = await this.client.create(
      {
        name,
        image: this.computerImage,
        tag: this.tag,
        comment: `${COMMENT_PREFIX}${botId}`,
        cpus: this.cpus,
        memory: this.memory,
      },
      deadlineSignal(CREATE_TIMEOUT_MS, signal),
    );
    this.hosts.set(name, created.host);
  }

  private async removeOwned(name: string, botId: string): Promise<void> {
    const signal = deadlineSignal(REQUEST_TIMEOUT_MS);
    const vm = await this.vm(name, signal);
    if (!vm) return;
    this.assertOwner(vm, name, botId);
    await this.remove(name, signal);
  }

  /** Deletes this bot's VMs other than its stored one, such as one a dead start left. */
  private async removeOrphans(botId: string, keep: string | undefined, signal: AbortSignal) {
    let vms: ExeVm[];
    try {
      vms = await this.client.list(deadlineSignal(REQUEST_TIMEOUT_MS, signal));
    } catch (error) {
      signal.throwIfAborted();
      getLogger().warn("list exe.dev computers left by earlier starts", { error });
      return;
    }
    for (const vm of vms) {
      if (vm.name === keep || !this.owns(vm, botId)) continue;
      await this.discard(vm.name, botId);
    }
  }

  /**
   * Deletes a VM no computer will use again, trying again and handing one that stays to the
   * unreferenced-machine sweep, so a failed delete never leaves it billing. Never rejects.
   */
  private async discard(name: string, botId: string): Promise<void> {
    await deleteUnreferencedMachine(
      this.machines,
      { provider: "exe", machineId: name, homeKey: botId },
      (signal) => this.remove(name, signal),
    );
  }

  private async remove(name: string, signal: AbortSignal): Promise<void> {
    await this.client.remove(name, deadlineSignal(REQUEST_TIMEOUT_MS, signal));
    this.hosts.delete(name);
  }

  private async vm(name: string, signal: AbortSignal): Promise<ExeVm | undefined> {
    const vm = await this.client.get(name, deadlineSignal(REQUEST_TIMEOUT_MS, signal));
    if (vm) this.hosts.set(name, vm.host);
    return vm;
  }

  private async host(name: string, signal: AbortSignal): Promise<string> {
    const known = this.hosts.get(name);
    if (known) return known;
    const vm = await this.vm(name, signal);
    if (!vm) throw sandboxGone(name);
    return this.hosts.get(name) ?? `${name}.exe.xyz`;
  }

  private async proxyHeaders(computer: ComputerRef, context: AdapterContext) {
    const name = vmName(computer);
    const expiresAt = Math.floor((Date.now() + SCREEN_TOKEN_MS) / 1000);
    const token = await this.client.vmToken(
      name,
      expiresAt,
      deadlineSignal(REQUEST_TIMEOUT_MS, context.signal),
    );
    return { "X-Exedev-Authorization": `Bearer ${token}` };
  }

  private owns(vm: ExeVm, botId: string): boolean {
    return (
      vm.name.startsWith(NAME_PREFIX) &&
      vm.comment === `${COMMENT_PREFIX}${botId}` &&
      (!this.tag || vm.tags.includes(this.tag))
    );
  }

  private assertOwner(vm: ExeVm, name: string, botId: string) {
    if (!this.owns(vm, botId)) throw new Error(`exe.dev VM ${name} belongs to another bot`);
  }

  /** Reports a confirmed missing or stopped VM as gone, and anything else as it was. */
  private async goneOr(name: string, error: unknown): Promise<unknown> {
    let vm: ExeVm | undefined;
    try {
      vm = await this.vm(name, deadlineSignal(REQUEST_TIMEOUT_MS));
    } catch {
      return error;
    }
    return vm?.status === "running" ? error : sandboxGone(name, error);
  }
}

function vmName(computer: ComputerRef): string {
  return computer.providerRef || computer.id;
}

function sandboxGone(name: string, cause?: unknown): Error {
  return sandboxNotFoundError(`exe.dev computer ${name} no longer exists`, { cause });
}
