import type {
  ApiResponse,
  ArtifactRequest,
  Command200Response,
  CommandOperationRequest,
  CommandResponse,
  CommandStatusRequest,
  CommandStatusResponse,
  CreateDownloadUrlRequest,
  CreateRequest,
  CreateSandboxResponse,
  CreateUploadUrlRequest,
  FileUrlResponse,
  FileWriteResponse,
  GetRequest,
  HostPortOperationRequest,
  HostPortResponse,
  Recover200Response,
  RecoverRequest,
  ResumeOperationRequest,
  Sandbox,
  SandboxActionResponse,
  SandboxInfoResponse,
  SandboxStateEnum,
  StopOperationRequest,
  UpdateRequest,
  WriteFileRequest,
} from "@boatdev/sdk";
import { ResponseError } from "@boatdev/sdk";
import { parse } from "shell-quote";
import type { BoatSandboxSdk } from "./boat-sandbox.js";
import { BoatSandboxProvider } from "./boat-sandbox.js";
import { desktopCommandResponder } from "./linux-desktop.test-support.js";

/** How a sandbox in the `error` state answers `POST /recover`, per the Boat API reference. */
export type BoatRecovery =
  | "recovers"
  | "stuck"
  | "no_machine"
  | "too_soon"
  | "sandbox_is_reachable"
  | "recover_unsupported"
  | "reset_failed";

interface FakeSandbox {
  sandbox: Sandbox;
  env: Record<string, string>;
  files: Map<string, { content: Uint8Array; executable: boolean }>;
  recovery: BoatRecovery;
}

/** Boat's artifact route refuses larger files; download URLs have no size limit. */
export const BOAT_ARTIFACT_MAX_BYTES = 50 * 1024 * 1024;

const RUNNABLE = new Set<SandboxStateEnum>(["ready", "idle", "running"]);
// Where each in-flight state settles by the next read.
const SETTLES_TO: Partial<Record<SandboxStateEnum, SandboxStateEnum>> = {
  init: "ready",
  provisioning: "ready",
  provisioned: "ready",
  cloning: "ready",
  archiving: "archived",
};

/**
 * In-memory Boat API with the documented lifecycle states and error codes. It answers like the
 * SDK, throwing raw `ResponseError`s, so tests exercise the real adapter's error handling. Its
 * shell understands only what the adapter sends: workspace listings, chmod, and simple commands.
 */
export class FakeBoatApi implements BoatSandboxSdk {
  private readonly sandboxes = new Map<string, FakeSandbox>();
  private readonly desktop = desktopCommandResponder();
  private readonly detached = new Map<number, CommandResponse>();
  private created = 0;
  private readonly uploads = new Map<string, { sandboxId: string; path: string }>();
  private readonly downloads = new Map<string, { sandboxId: string; path: string }>();
  private startsExhausted = false;
  private rejectAll?: { status: number; code: string; message: string };

  /** Puts a sandbox in any documented state; in-flight states settle by the next read. */
  setState(id: string, state: SandboxStateEnum): void {
    this.require(id).sandbox.state = state;
  }

  /** Stops the sandbox and deletes its snapshot data, as Boat does 14 days after a stop. */
  expire(id: string): void {
    const box = this.require(id);
    box.sandbox.state = "archived";
    box.sandbox.dataExpiredAt = new Date();
    box.sandbox.snapshotAvailable = false;
  }

  fail(id: string, recovery: BoatRecovery = "recovers"): void {
    const box = this.require(id);
    box.sandbox.state = "error";
    box.recovery = recovery;
  }

  /** Boat reports a cancelled sandbox once, then answers 404. */
  cancel(id: string): void {
    this.require(id).sandbox.state = "cancelled";
  }

  delete(id: string): void {
    this.sandboxes.delete(id);
  }

  /** Refuses every later create and resume as over the account's machine-start limit. */
  rateLimit(): void {
    this.startsExhausted = true;
  }

  unauthorized(): void {
    this.rejectAll = { status: 401, code: "unauthorized", message: "Invalid bearer token" };
  }

  state(id: string): SandboxStateEnum | undefined {
    return this.sandboxes.get(id)?.sandbox.state;
  }

  files(id: string): Map<string, { content: Uint8Array; executable: boolean }> {
    return this.require(id).files;
  }

  async create(request: CreateRequest = {}): Promise<CreateSandboxResponse> {
    this.start();
    const id = `bx_fake${++this.created}`;
    const sandbox: Sandbox = {
      id,
      name: "Fake Boat",
      state: "ready",
      dataExpiredAt: null,
      desktopAvailable: true,
      snapshotAvailable: false,
    };
    this.sandboxes.set(id, {
      sandbox,
      env: { ...request.createSandboxRequest?.env },
      files: new Map(),
      recovery: "recovers",
    });
    return {
      ok: true,
      type: "sandbox.created",
      status: "ready",
      ttlSeconds: request.createSandboxRequest?.ttlSeconds ?? null,
      sandbox: { ...sandbox },
    };
  }

  async get({ sandboxId }: GetRequest): Promise<SandboxInfoResponse> {
    const box = this.require(sandboxId);
    const response = this.info(box);
    const settled = SETTLES_TO[box.sandbox.state];
    if (settled) box.sandbox.state = settled;
    if (box.sandbox.state === "cancelled") this.sandboxes.delete(sandboxId);
    return response;
  }

  async resume({ sandboxId }: ResumeOperationRequest): Promise<SandboxActionResponse> {
    const box = this.require(sandboxId);
    if (box.sandbox.dataExpiredAt) {
      throw boatError(409, "snapshot_data_expired", "The snapshot data of this sandbox expired");
    }
    if (box.sandbox.state === "archived" || box.sandbox.state === "error") {
      this.start();
      box.sandbox.state = "ready";
    }
    return this.action(box);
  }

  async recover({ sandboxId }: RecoverRequest): Promise<Recover200Response> {
    const box = this.require(sandboxId);
    if (box.sandbox.state !== "error") {
      throw boatError(409, "sandbox_is_reachable", "The sandbox answers normally");
    }
    switch (box.recovery) {
      case "recovers":
        box.sandbox.state = "ready";
        return { ok: true, type: "sandbox.recover", status: "recovering" };
      case "stuck":
        return { ok: true, type: "sandbox.recover", status: "recovering" };
      case "too_soon":
      case "sandbox_is_reachable":
        // An earlier recover brings it back.
        box.sandbox.state = "ready";
        throw boatError(409, box.recovery, "Recover refused");
      default:
        throw boatError(409, box.recovery, "Recover refused");
    }
  }

  async stop({ sandboxId }: StopOperationRequest): Promise<SandboxActionResponse> {
    const box = this.require(sandboxId);
    box.sandbox.state = "archived";
    box.sandbox.snapshotAvailable = true;
    return this.action(box);
  }

  async update({ sandboxId }: UpdateRequest): Promise<SandboxInfoResponse> {
    return this.info(this.require(sandboxId));
  }

  async hostPort({
    sandboxId,
    hostPortRequest,
  }: HostPortOperationRequest): Promise<HostPortResponse> {
    this.runnable(sandboxId);
    return {
      ok: true,
      type: "sandbox.host",
      url: `https://${sandboxId}-${hostPortRequest.port}.on.boat.dev?_token=secret`,
    };
  }

  async createUploadUrl({
    sandboxId,
    fileUrlRequest,
  }: CreateUploadUrlRequest): Promise<FileUrlResponse> {
    this.runnable(sandboxId);
    const url = `https://uploads.on.boat.dev/file?token=fake-upload-${this.uploads.size}`;
    this.uploads.set(url, { sandboxId, path: fileUrlRequest.path });
    return {
      ok: true,
      type: "file.upload_url",
      method: "PUT",
      url,
      path: fileUrlRequest.path,
      expiresAt: new Date(Date.now() + 900_000),
    };
  }

  async createDownloadUrl({
    sandboxId,
    fileUrlRequest,
  }: CreateDownloadUrlRequest): Promise<FileUrlResponse> {
    this.runnable(sandboxId);
    const url = `https://downloads.on.boat.dev/file?token=fake-download-${this.downloads.size}`;
    this.downloads.set(url, { sandboxId, path: fileUrlRequest.path });
    return {
      ok: true,
      type: "file.download_url",
      method: "GET",
      url,
      path: fileUrlRequest.path,
      expiresAt: new Date(Date.now() + 900_000),
    };
  }

  /** What the sandbox serves at a download URL. */
  serveDownload(url: string): Response {
    const download = this.downloads.get(url);
    if (!download) return new Response(null, { status: 404 });
    const file = this.runnable(download.sandboxId).files.get(download.path);
    if (!file) return new Response(null, { status: 404 });
    return new Response(Buffer.from(file.content));
  }

  completeUpload(url: string, content: Uint8Array): void {
    const upload = this.uploads.get(url);
    if (!upload) throw new Error("Unknown fake upload");
    this.runnable(upload.sandboxId).files.set(upload.path, { content, executable: false });
  }

  async writeFile({ sandboxId, fileWriteRequest }: WriteFileRequest): Promise<FileWriteResponse> {
    const box = this.runnable(sandboxId);
    const content = Uint8Array.from(Buffer.from(fileWriteRequest.content, "base64"));
    if (content.byteLength > 5 * 1024 * 1024) {
      throw boatError(400, "sandbox_direct_failed", "File exceeds the inline write limit");
    }
    box.files.set(fileWriteRequest.path, { content, executable: false });
    return {
      ok: true,
      type: "file.written",
      success: true,
      path: fileWriteRequest.path,
      encoding: "base64",
      size: content.byteLength,
    };
  }

  async artifactRaw({ sandboxId, path }: ArtifactRequest): Promise<ApiResponse<Blob>> {
    const file = this.runnable(sandboxId).files.get(path);
    if (!file) throw boatError(404, "not_found", `File not found: ${path}`);
    if (file.content.byteLength > BOAT_ARTIFACT_MAX_BYTES) {
      throw boatError(
        400,
        "artifact_failed",
        `Artifact is too large (${file.content.byteLength} bytes > ${BOAT_ARTIFACT_MAX_BYTES})`,
      );
    }
    return {
      raw: new Response(Buffer.from(file.content), {
        headers: { "content-length": String(file.content.byteLength) },
      }),
      value: async () => new Blob([Buffer.from(file.content)]),
    };
  }

  async command({
    sandboxId,
    commandRequest,
  }: CommandOperationRequest): Promise<Command200Response> {
    const result = this.shell(this.runnable(sandboxId), commandRequest.command);
    if (!commandRequest.detached) return result;
    const processId = this.detached.size + 1;
    this.detached.set(processId, result);
    return {
      ok: true,
      type: "command.started",
      success: true,
      processId,
      pid: processId,
      command: commandRequest.command,
      startedAt: new Date(),
    };
  }

  async commandStatus({
    sandboxId,
    processId,
  }: CommandStatusRequest): Promise<CommandStatusResponse> {
    this.require(sandboxId);
    const result = this.detached.get(processId);
    if (!result) throw boatError(404, "not_found", "Process not found");
    return {
      ok: true,
      type: "command.status",
      success: true,
      processId,
      status: "exited",
      running: false,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    this.check();
    this.sandboxes.delete(sandboxId);
  }

  private check(): void {
    if (this.rejectAll) {
      const { status, code, message } = this.rejectAll;
      throw boatError(status, code, message);
    }
  }

  private start(): void {
    this.check();
    if (this.startsExhausted) {
      throw boatError(429, "rate_limited", "Rate limit hit: machine starts per day");
    }
  }

  private require(id: string): FakeSandbox {
    this.check();
    const box = this.sandboxes.get(id);
    if (!box) throw boatError(404, "not_found", "Sandbox not found");
    return box;
  }

  private runnable(id: string): FakeSandbox {
    const box = this.require(id);
    if (!RUNNABLE.has(box.sandbox.state)) {
      throw boatError(409, "sandbox_not_ready", `Sandbox is ${box.sandbox.state}`);
    }
    return box;
  }

  private info(box: FakeSandbox): SandboxInfoResponse {
    return { ok: true, type: "sandbox.info", sandbox: { ...box.sandbox } };
  }

  private action(box: FakeSandbox): SandboxActionResponse {
    return {
      ok: true,
      type: "sandbox.action",
      id: box.sandbox.id,
      status: box.sandbox.state,
      sandbox: { ...box.sandbox },
    };
  }

  private shell(box: FakeSandbox, wrapped: string): CommandResponse {
    // The adapter wraps commands as `timeout ... bash -lc <command>`.
    const tokens = parse(wrapped, (name) => `$${name}`);
    const last = tokens.at(-1);
    const command = tokens[0] === "timeout" && typeof last === "string" ? last : wrapped;
    const desktop = this.desktop(command);
    if (desktop) return finished(desktop);

    // `exec 3< FILE || exit 1; rm -f -- FILE; . /dev/fd/3 || exit 1; exec 3<&-; argv`
    const sourced = command.match(
      /^exec 3< ('[^']*') \|\| exit 1; rm -f -- \1; \. \/dev\/fd\/3 \|\| exit 1; exec 3<&-; ([\s\S]*)$/,
    );
    if (sourced) {
      const envFile = String(parse(sourced[1]!)[0]);
      const file = box.files.get(envFile);
      if (!file) return finished({ exitCode: 1, stderr: "No such file or directory\n" });
      box.files.delete(envFile);
      const env = { ...box.env };
      for (const token of parse(Buffer.from(file.content).toString("utf8"))) {
        if (typeof token !== "string" || token === "export") continue;
        const [name, ...value] = token.split("=");
        env[name!] = value.join("=");
      }
      const argv = parse(sourced[2]!).filter((token): token is string => typeof token === "string");
      return finished(simpleCommand(argv, env));
    }

    const directory = command.match(/^directory=(.*)$/m)?.[1];
    if (directory !== undefined) {
      const root = String(parse(directory)[0]);
      const children = new Map<string, "file" | "dir">();
      for (const filePath of box.files.keys()) {
        if (!filePath.startsWith(`${root}/`)) continue;
        const [child, ...rest] = filePath.slice(root.length + 1).split("/");
        children.set(`${root}/${child}`, rest.length ? "dir" : "file");
      }
      if (!children.size) return finished({ exitCode: 1, stderr: "No such directory\n" });
      return finished({
        stdout: [...children]
          .map(([entry, kind]) => listing(entry, kind, box.files.get(entry)))
          .join(""),
      });
    }
    if (command.includes("find ") && command.includes("-type f")) {
      return finished({
        stdout: [...box.files].map(([filePath, file]) => listing(filePath, "file", file)).join(""),
      });
    }

    const parsed = parse(command, (name) => box.env[name] ?? "");
    const argv = parsed.filter((token): token is string => typeof token === "string");
    if (argv[0] === "chmod") {
      // `chmod 700 a && chmod 600 b ...`
      for (let index = 0; index < argv.length; index += 3) {
        const file = box.files.get(argv[index + 2] ?? "");
        if (file) file.executable = argv[index + 1] === "700";
      }
      return finished({});
    }
    if (argv[0] === "rm") {
      for (const filePath of argv.slice(1)) box.files.delete(filePath);
      return finished({});
    }
    // Scripts with shell operators are setup the fake has no state for.
    if (argv.length !== parsed.length) return finished({});
    return finished(simpleCommand(argv, box.env));
  }
}

/** `env [NAME=value...] [-u NAME...] [--] command`, then `echo` and `printenv`. */
function simpleCommand(
  argv: string[],
  inherited: Record<string, string>,
): Partial<CommandResponse> {
  const env: Record<string, string | undefined> = { ...inherited };
  let rest = argv;
  while (rest[0] === "env") {
    rest = rest.slice(1);
    while (rest.length) {
      const [first, second] = rest;
      if (first === "-u" && second) {
        delete env[second];
        rest = rest.slice(2);
      } else if (first === "--") {
        rest = rest.slice(1);
        break;
      } else if (first?.includes("=")) {
        const [name, ...value] = first.split("=");
        env[name!] = value.join("=");
        rest = rest.slice(1);
      } else break;
    }
  }
  const [program, ...args] = rest;
  if (program === "echo") return { stdout: `${args.join(" ")}\n` };
  if (program === "printenv") {
    const value = env[args[0] ?? ""];
    return value === undefined ? { exitCode: 1 } : { stdout: `${value}\n` };
  }
  return {};
}

function listing(
  absolute: string,
  kind: "file" | "dir",
  file?: { content: Uint8Array; executable: boolean },
): string {
  const encoded = Buffer.from(absolute).toString("base64");
  return `${encoded}\t${kind}\t${file?.content.byteLength ?? 0}\t${file?.executable ? 1 : 0}\n`;
}

function finished(result: Partial<CommandResponse>): CommandResponse {
  return {
    ok: true,
    type: "command.finished",
    success: (result.exitCode ?? 0) === 0,
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...result,
  };
}

/** The real Boat adapter over an in-memory Boat API. */
export function fakeBoatProvider(api = new FakeBoatApi()): BoatSandboxProvider {
  return new BoatSandboxProvider({ apiKey: "test-key" }, api);
}

/** What the SDK throws for a non-2xx response: Boat's error envelope behind a `ResponseError`. */
export function boatError(status: number, code: string, message: string): ResponseError {
  return new ResponseError(
    Response.json(
      { ok: false, type: "error", status, code, message, error: { code, message, status } },
      { status },
    ),
    "Response returned an error code",
  );
}
