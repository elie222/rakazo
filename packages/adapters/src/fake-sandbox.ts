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
  ScreenSession,
} from "@rakazo/adapter-kit";
import {
  applyPlaceholderAction,
  boundedComputerActions,
  normalizeWorkspacePath,
  placeholderObservation,
} from "./computer-support.js";

export interface FakeBox {
  ref: ComputerRef;
  files: Map<string, { content: Uint8Array; executable: boolean }>;
  running: boolean;
  screen: string;
}

export class FakeSandboxProvider implements SandboxProvider {
  readonly boxes = new Map<string, FakeBox>();

  describe() {
    return {
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: true,
      },
    };
  }

  async provision(
    request: { botId: string; homePath: string },
    _context: AdapterContext,
  ): Promise<ComputerRef> {
    const id = `fake-${request.botId}`;
    const existing = this.boxes.get(id);
    if (existing) {
      existing.running = true;
      return { ...existing.ref, fresh: false };
    }
    const ref: ComputerRef = {
      id,
      botId: request.botId,
      kind: "fake",
      providerRef: id,
      fresh: true,
    };
    this.boxes.set(ref.id, {
      ref,
      files: new Map(),
      running: true,
      screen: "ready",
    });
    return ref;
  }

  async prepare(_computer: ComputerRef, _context: AdapterContext): Promise<void> {}

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    _context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const box = this.boxes.get(computer.id);
    if (!box) {
      yield { type: "stderr", data: "computer not found" };
      yield { type: "exit", code: 1 };
      return;
    }
    const cmd = request.argv.join(" ");
    if (request.argv[0] === "echo") {
      yield { type: "stdout", data: `${request.argv.slice(1).join(" ")}\n` };
    } else if (cmd.startsWith("cat ")) {
      const file = normalizeWorkspacePath(request.argv[1] ?? "");
      const stored = box.files.get(file);
      yield { type: "stdout", data: stored ? new TextDecoder().decode(stored.content) : "" };
    } else {
      yield { type: "stdout", data: `ran ${cmd}\n` };
    }
    yield { type: "exit", code: 0 };
  }

  async connectScreen(
    computer: ComputerRef,
    _request: ScreenRequest,
    _context: AdapterContext,
  ): Promise<ScreenSession> {
    return {
      url: `fake://screen/${computer.id}`,
      mimeType: "text/plain",
      close: async () => undefined,
    };
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    _context: AdapterContext,
  ): Promise<void> {
    const box = this.boxes.get(computer.id);
    if (box) applyPlaceholderAction(box, input);
  }

  async observe(computer: ComputerRef, _context: AdapterContext) {
    return placeholderObservation(this.requiredBox(computer).screen);
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, _context: AdapterContext) {
    const box = this.requiredBox(computer);
    const actions = boundedComputerActions(request.actions);
    for (const action of actions) applyPlaceholderAction(box, action);
    return {
      completed: actions.length,
      ...(request.observe === false ? {} : { observation: await this.observe(computer, _context) }),
    };
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    _context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const box = this.requiredBox(computer);
    const normalized = normalizeWorkspacePath(directory);
    const prefix = normalized ? `${normalized}/` : "";
    const entries = new Map<string, ComputerFileEntry>();
    for (const [filePath, file] of box.files) {
      if (!filePath.startsWith(prefix)) continue;
      const remainder = filePath.slice(prefix.length);
      const [name, ...rest] = remainder.split("/");
      if (!name) continue;
      const listedPath = prefix + name;
      entries.set(listedPath, {
        path: listedPath,
        kind: rest.length ? "dir" : "file",
        size: rest.length ? 0 : file.content.byteLength,
        ...(!rest.length && file.executable ? { executable: true } : {}),
      });
    }
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    _context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const file = this.requiredBox(computer).files.get(normalizeWorkspacePath(filePath));
    if (!file) throw new Error("computer file not found");
    if (options?.maxBytes !== undefined && file.content.byteLength > options.maxBytes) {
      throw new Error(`computer file exceeds ${options.maxBytes} bytes`);
    }
    return new Uint8Array(file.content);
  }

  async writeFile(computer: ComputerRef, file: PortableFile, _context: AdapterContext) {
    this.requiredBox(computer).files.set(normalizeWorkspacePath(file.path), {
      content: new Uint8Array(file.content),
      executable: file.executable === true,
    });
  }

  async *exportWorkspace(
    computer: ComputerRef,
    _context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    for (const [filePath, file] of [...this.requiredBox(computer).files].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      yield {
        path: filePath,
        content: new Uint8Array(file.content),
        executable: file.executable,
      };
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    _context: AdapterContext,
  ) {
    const box = this.requiredBox(computer);
    for await (const file of files) {
      box.files.set(normalizeWorkspacePath(file.path), {
        content: new Uint8Array(file.content),
        executable: file.executable === true,
      });
    }
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    return { id: `snap-${computer.id}`, createdAt: new Date().toISOString() };
  }

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const box = this.boxes.get(computer.id);
    if (box) box.running = false;
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    this.boxes.delete(computer.id);
  }

  private requiredBox(computer: ComputerRef): FakeBox {
    const box = this.boxes.get(computer.id);
    if (!box) throw new Error("computer not found");
    return box;
  }
}
