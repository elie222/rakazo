import type { UnreferencedMachineRecords } from "@rakazo/adapter-kit";
import type { ComputerSize } from "@rakazo/contracts";
import { parse } from "shell-quote";
import type {
  Kosa8Api,
  Kosa8CreateRequest,
  Kosa8ExecResult,
  Kosa8Sandbox,
  Kosa8Snapshot,
} from "./kosa8-api.js";
import { Kosa8ApiError } from "./kosa8-api.js";
import { Kosa8SandboxProvider, kosa8ComputerSnapshot, kosa8Sdk } from "./kosa8-sandbox.js";
import { desktopCommandResponder, simpleCommand } from "./linux-desktop.test-support.js";

interface EmulatedComputer {
  state: "running" | "sleeping";
  template: string;
  snapshot?: string;
  name: string;
  labels: Record<string, string>;
  sleepAfterS: number;
  /** Keyed by the path inside the computer, /home/user resolved to /workspace/user. */
  files: Map<string, { content: Uint8Array; mode: number }>;
  published: Set<number>;
  respond: ReturnType<typeof desktopCommandResponder>;
  /** Runs still going, by their marker. */
  running: Set<string>;
}

const SIZES: ComputerSize[] = ["standard", "large", "xlarge"];

/**
 * In-memory kosa8 Cloud: sandboxes from a pool template or a snapshot, sleep and wake, streamed
 * commands under `timeout`, the /workspace-only file API, previews and snapshots, with kosa8's
 * error statuses. Its shell understands only what the adapter sends: desktop runtime scripts, the
 * home link, mkdir, find, stat, chmod, cp, mv, rm, the run-ending script, `env`, `echo` and
 * `printenv`. Like kosa8, it refuses an argument longer than 8 KiB.
 */
export class Kosa8Emulator implements Kosa8Api {
  readonly computers = new Map<string, EmulatedComputer>();
  readonly saved: Array<Kosa8Snapshot & { size: ComputerSize }> = [];
  /** Every request the adapter made, in order. */
  readonly requests: string[] = [];
  /** Every command the adapter ran, unwrapped, in order. */
  readonly commands: string[] = [];
  /** Run markers the adapter asked to end. */
  readonly ended: string[] = [];
  /** Commands matching this never exit on their own; they end at their deadline or when ended. */
  hangs: (command: string) => boolean = () => false;
  /** Commands matching this exit 1. */
  fails: (command: string) => boolean = () => false;
  /** Each attempt to end a run; an Error fails it as a dropped connection does. */
  endRun: () => Error | undefined = () => undefined;
  /** Upcoming calls refused with 429. */
  rateLimited = 0;
  /** The next create is refused with this status and code. */
  refuseCreate: { status: number; code: string } | undefined;
  /** Templates the account's plan may start. */
  allowedTemplates = new Set(["universal-4x8", "universal-8x16"]);
  private sequence = 0;

  /** An account whose computer snapshots are already saved, as after the first computers. */
  constructor(options: { snapshots?: boolean } = {}) {
    if (options.snapshots !== false)
      for (const size of SIZES)
        this.saved.push({
          id: `snap_${size}`,
          name: kosa8ComputerSnapshot(size),
          state: "ready",
          size,
        });
  }

  async create(request: Kosa8CreateRequest): Promise<Kosa8Sandbox> {
    this.request(
      `create ${request.snapshot ? `snapshot ${request.snapshot}` : `template ${request.template}`}`,
    );
    if (this.refuseCreate) {
      const { status, code } = this.refuseCreate;
      this.refuseCreate = undefined;
      throw new Kosa8ApiError(status, code, `kosa8: ${code}`);
    }
    let template = request.template ?? "";
    if (request.snapshot) {
      const snapshot = this.saved.find((entry) => entry.id === request.snapshot);
      if (!snapshot) throw new Kosa8ApiError(404, "not_found", "kosa8: no such snapshot");
      template = `universal-${snapshot.size}`;
    } else if (!this.allowedTemplates.has(template)) {
      throw new Kosa8ApiError(402, "plan_limit", "kosa8: the plan does not offer that size");
    }
    const id = `sbx_test${++this.sequence}`;
    this.computers.set(id, {
      state: "running",
      template,
      ...(request.snapshot ? { snapshot: request.snapshot } : {}),
      name: request.name,
      labels: request.labels,
      sleepAfterS: request.sleepAfterS,
      files: new Map(),
      published: new Set(),
      respond: desktopCommandResponder(),
      running: new Set(),
    });
    return { id, state: "running" };
  }

  async get(id: string): Promise<Kosa8Sandbox> {
    this.request(`get ${id}`);
    return { id, state: this.require(id).state };
  }

  async sleep(id: string): Promise<void> {
    this.request(`sleep ${id}`);
    this.require(id).state = "sleeping";
  }

  async wake(id: string): Promise<void> {
    this.request(`wake ${id}`);
    this.require(id).state = "running";
  }

  async delete(id: string): Promise<boolean> {
    this.request(`delete ${id}`);
    return this.computers.delete(id);
  }

  async exec(
    id: string,
    script: string,
    options: { env: Record<string, string>; signal?: AbortSignal },
  ): Promise<Kosa8ExecResult> {
    this.request(`exec ${id}`);
    if (Buffer.byteLength(script) > 8192)
      throw new Kosa8ApiError(400, "invalid_cmd", "kosa8: cmd must be a list of strings");
    const computer = this.awake(id);
    const ending = script.match(/^m='RAKAZO_KOSA8_RUN=([\w-]+)'/)?.[1];
    if (ending) {
      const failure = this.endRun();
      if (failure) throw failure;
      this.ended.push(ending);
      computer.running.delete(ending);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    // Cleanup the adapter sends bare, outside a run.
    if (!script.startsWith("exec timeout ")) {
      this.commands.push(script);
      return this.shell(computer, script, options.env);
    }
    const [, , , , seconds, , , inner] = parse(script) as string[];
    let command = inner!;
    const fromFile = command.match(/^status=0; bash (\S+) \|\|/)?.[1];
    if (fromFile) {
      const file = computer.files.get(fromFile);
      computer.files.delete(fromFile);
      command = new TextDecoder().decode(file!.content);
    }
    command = command.replace(/^cd -- '[^']*' && /, "");
    this.commands.push(command);
    const run = options.env.RAKAZO_KOSA8_RUN!;
    if (this.hangs(command)) {
      computer.running.add(run);
      const ended = await settle(
        Number(seconds) * 1000,
        options.signal,
        () => !computer.running.has(run),
      );
      computer.running.delete(run);
      if (options.signal?.aborted) throw options.signal.reason;
      return { exitCode: ended === "deadline" ? 124 : 143, stdout: "", stderr: "" };
    }
    return this.shell(computer, command, options.env);
  }

  async readFile(id: string, path: string): Promise<Uint8Array> {
    this.request(`read ${path}`);
    this.inWorkspace(path);
    const file = this.awake(id).files.get(path);
    if (!file) throw new Kosa8ApiError(404, "not_found", `kosa8: no such file: ${path}`);
    return new Uint8Array(file.content);
  }

  async writeFile(id: string, path: string, data: Uint8Array): Promise<void> {
    this.request(`write ${path}`);
    this.inWorkspace(path);
    this.awake(id).files.set(path, { content: new Uint8Array(data), mode: 0o644 });
  }

  async publish(id: string, port: number): Promise<{ host: string }> {
    this.request(`publish ${id} ${port}`);
    this.require(id).published.add(port);
    return { host: `${port}-${id.slice(4)}.kosa8labs.test` };
  }

  async snapshot(id: string, name: string): Promise<Kosa8Snapshot> {
    this.request(`snapshot ${id} ${name}`);
    const size = SIZES.find((entry) => name.endsWith(`-${entry}`))!;
    const saved = { id: `snap_test${++this.sequence}`, name, state: "ready", size };
    this.require(id);
    this.saved.push(saved);
    return saved;
  }

  async snapshots(): Promise<Kosa8Snapshot[]> {
    this.request("snapshots");
    return this.saved.map(({ size: _size, ...snapshot }) => snapshot);
  }

  async deleteSnapshot(id: string): Promise<void> {
    this.request(`delete snapshot ${id}`);
    const at = this.saved.findIndex((entry) => entry.id === id);
    if (at >= 0) this.saved.splice(at, 1);
  }

  private request(name: string) {
    this.requests.push(name);
    if (this.rateLimited > 0) {
      this.rateLimited--;
      throw new Kosa8ApiError(429, "rate_limited", "kosa8: too many requests", 1_000);
    }
  }

  private require(id: string): EmulatedComputer {
    const computer = this.computers.get(id);
    if (!computer) throw new Kosa8ApiError(404, "not_found", "kosa8: no such sandbox");
    return computer;
  }

  /** kosa8 wakes a sleeping computer for a command or a file request. */
  private awake(id: string): EmulatedComputer {
    const computer = this.require(id);
    computer.state = "running";
    return computer;
  }

  private inWorkspace(path: string) {
    if (!path.startsWith("/workspace/"))
      throw new Kosa8ApiError(
        400,
        "bad_request",
        `kosa8: path "${path}" is outside the workspace; use a path under /workspace`,
      );
  }

  private shell(
    computer: EmulatedComputer,
    command: string,
    envs: Record<string, string>,
  ): Kosa8ExecResult {
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    if (this.fails(command)) return { exitCode: 1, stdout: "", stderr: "permission denied\n" };
    const desktop = computer.respond(command);
    if (desktop) return desktop;
    if (command.includes("ln -s")) return ok();
    const parsed = parse(command, (name) => envs[name] ?? "");
    const argv = parsed.filter((token): token is string => typeof token === "string");
    const files = computer.files;
    if (argv[0] === "mkdir" && argv[1] === "-p" && argv[2] === "/workspace/.rakazo-transfer") {
      // `mkdir … && cp -- src dst`: a read staged into the workspace.
      const [source, target] = argv.slice(-2);
      const file = files.get(resolve(source!));
      if (!file) return { exitCode: 1, stdout: "", stderr: "cp: No such file or directory\n" };
      files.set(target!, { ...file });
      return ok();
    }
    if (argv[0] === "mkdir" && argv.includes("mv")) {
      const [source, target] = argv.slice(-2);
      const file = files.get(source!);
      files.delete(source!);
      if (file) files.set(resolve(target!), file);
      return ok();
    }
    if (argv[0] === "mkdir") return ok();
    if (argv[0] === "rm") {
      files.delete(resolve(argv.at(-1)!));
      return ok();
    }
    if (argv[0] === "chmod") {
      for (const path of argv.slice(3)) {
        const file = files.get(resolve(path));
        if (file) file.mode = argv[1] === "700" ? 0o700 : 0o644;
      }
      return ok();
    }
    if (argv[0] === "stat") {
      const file = files.get(resolve(argv.at(-1)!));
      if (!file) return { exitCode: 1, stdout: "", stderr: "stat: No such file or directory\n" };
      return ok(`${file.content.byteLength} ${file.mode.toString(8)}\n`);
    }
    if (argv[0] === "find") return ok(listing(computer, resolve(argv[1]!)));
    // Scripts with shell operators are setup the emulator has no state for.
    if (argv.length !== parsed.length || argv[0] === "bash") return ok();
    const { exitCode = 0, stdout = "" } = simpleCommand(argv, envs);
    return { exitCode, stdout, stderr: "" };
  }
}

/** /home/user is a link to /workspace/user, as the adapter makes it. */
function resolve(path: string): string {
  return path === "/home/user" || path.startsWith("/home/user/")
    ? `/workspace/user${path.slice("/home/user".length)}`
    : path;
}

/** `find -printf '%y %s %m %f\0'` over the emulated files, directories implied by their paths. */
function listing(computer: EmulatedComputer, directory: string): string {
  const entries = new Map<string, string>();
  for (const [path, file] of computer.files) {
    if (!path.startsWith(`${directory}/`)) continue;
    const [name, ...rest] = path.slice(directory.length + 1).split("/");
    entries.set(
      name!,
      rest.length
        ? `d 4096 755 ${name}`
        : `f ${file.content.byteLength} ${file.mode.toString(8)} ${name}`,
    );
  }
  return [...entries.values()].map((entry) => `${entry}\0`).join("");
}

/** Resolves at the deadline, on abort, or once ended. */
async function settle(
  deadlineMs: number,
  signal: AbortSignal | undefined,
  ended: () => boolean,
): Promise<"deadline" | "ended" | "aborted"> {
  return new Promise((resolve) => {
    const done = (why: "deadline" | "ended" | "aborted") => {
      clearTimeout(timer);
      clearInterval(poll);
      resolve(why);
    };
    const timer = setTimeout(() => done("deadline"), deadlineMs);
    const poll = setInterval(() => ended() && done("ended"), 5);
    signal?.addEventListener("abort", () => done("aborted"), { once: true });
  });
}

/** The real kosa8 adapter, API translation included, over the in-memory emulator. */
export function emulatedKosa8(
  emulator = new Kosa8Emulator(),
  machines?: UnreferencedMachineRecords,
) {
  const provider = () =>
    new Kosa8SandboxProvider(
      { apiKey: "test-kosa8-key" },
      kosa8Sdk(
        emulator,
        async (id) => {
          emulator.requests.push(`fence ${id}`);
        },
        machines,
      ),
    );
  return { emulator, provider };
}
