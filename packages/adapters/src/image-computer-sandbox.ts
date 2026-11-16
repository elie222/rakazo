import type {
  AdapterContext,
  AdapterDescriptor,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxCapabilities,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
  TerminalRequest,
} from "@rakazo/adapter-kit";
import type { RawExec } from "./exec-computer.js";
import { ExecComputer, COMPUTER_IMAGE_WORKSPACE as WORKSPACE } from "./exec-computer.js";
import { LinuxDesktop, onBotScreen } from "./linux-desktop.js";

const DISPLAY_START = 20;
/** The image's screen gateway, which answers once the computer is up. */
export const READY_PORT = 6080;
/** The first screen's ports; later screens take the ones after it. */
export const DESKTOP_PORT_START = 6100;

type ProvisionRequest = Parameters<SandboxProvider["provision"]>[0];

/**
 * A computer started from the published computer image and reached over an exec transport.
 * Providers supply the machine lifecycle, the transport, and the address its screens are served
 * on; commands, files, workspace transfer and screens work the same on all of them.
 */
export abstract class ImageComputerSandbox implements SandboxProvider {
  protected readonly shell: ExecComputer;
  protected readonly desktops: LinuxDesktop;

  /** `label` names the provider in error messages. */
  constructor(
    private readonly kind: string,
    label: string,
  ) {
    this.shell = new ExecComputer((...exec) => this.execRaw(...exec), label);
    this.desktops = new LinuxDesktop({
      environment: async (computer, context) => ({
        homeDir: WORKSPACE,
        workspaceDir: WORKSPACE,
        browserProfilesDir: `${WORKSPACE}/.browser-profiles`,
        displayStart: DISPLAY_START,
        portStart: DESKTOP_PORT_START,
        bindHost: await this.relayBindHost(computer, context),
      }),
      run: (computer, command, context) =>
        this.shell.run(computer, ["bash", "-c", command], context),
      // Stock vnc.html reads localStorage, which throws in the opaque origin of the sandboxed
      // screen frame and leaves a black screen; the image's embed.html works there.
      screenUrl: async (computer, port, context) => {
        const address = await this.screenAddress(computer, context);
        const host = address.includes(":") ? `[${address}]` : address;
        return `http://${host}:${port}/embed.html`;
      },
    });
  }

  abstract provision(request: ProvisionRequest, context: AdapterContext): Promise<ComputerRef>;
  abstract isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean>;
  abstract stop(computer: ComputerRef, context: AdapterContext): Promise<void>;
  abstract destroy(computer: ComputerRef, context: AdapterContext): Promise<void>;
  /** Runs an argv in the computer as the image user. */
  protected abstract execRaw(...exec: Parameters<RawExec>): ReturnType<RawExec>;
  /** The address the API, worker and web reach the computer's screen ports on. */
  protected abstract screenAddress(computer: ComputerRef, context: AdapterContext): Promise<string>;
  /** The address the screen relay listens on: the family the web connects with. */
  protected abstract relayBindHost(computer: ComputerRef, context: AdapterContext): Promise<string>;

  /** Whether the computer keeps its home in place across stops. */
  protected persistentHome(): boolean {
    return false;
  }

  /** Lets a provider report a computer that is gone when taking or giving back control fails. */
  protected async screenControlFailure(
    _computer: ComputerRef,
    error: unknown,
    _context: AdapterContext,
  ): Promise<unknown> {
    return error;
  }

  describe(): AdapterDescriptor<SandboxCapabilities> {
    return {
      id: this.kind,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: this.persistentHome(),
        multiScreen: true,
      },
    };
  }

  /** True once the image's screen gateway answers inside the computer. */
  protected async screenGatewayUp(computer: ComputerRef, context: AdapterContext) {
    try {
      const probe = await this.shell.run(
        computer,
        ["bash", "-c", `: </dev/tcp/127.0.0.1/${READY_PORT}`],
        context,
        10_000,
      );
      return probe.code === 0;
    } catch {
      // A computer still starting cannot run the probe; the caller asks again until its deadline.
      return false;
    }
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    await this.shell.prepare(computer, context);
  }

  async *execute(
    computer: ComputerRef,
    requested: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    yield* this.shell.execute(computer, onBotScreen(requested, context, DISPLAY_START), context);
  }

  connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    return this.desktops.connectScreen(computer, request, context);
  }

  connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    // The API already holds the human control token. A new run may supersede the bot's screen
    // fence while the human keeps control of the same computer, so the terminal ignores it.
    return this.desktops.connectTerminal(computer, request, {
      ...context,
      screenLeaseId: undefined,
    });
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ): Promise<void> {
    try {
      await this.desktops.setScreenControl(computer, interactive, context, controlToken);
    } catch (error) {
      throw await this.screenControlFailure(computer, error, context);
    }
  }

  sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    return this.desktops.sendInput(computer, input, context);
  }

  observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    return this.desktops.observe(computer, context);
  }

  act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return this.desktops.act(computer, request, context);
  }

  releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    return this.desktops.releaseScreen(computer, context);
  }

  listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    return this.shell.listFiles(computer, directory, context);
  }

  readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    return this.shell.readFile(computer, filePath, context, options);
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    await this.shell.writeFile(computer, file, context);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    await this.desktops.stopBrowsers(computer, context);
    yield* this.shell.exportWorkspace(computer, context);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    await this.desktops.stopBrowsers(computer, context);
    await this.shell.importWorkspace(computer, files, context);
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    const observation = await this.observe(computer, context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }
}
