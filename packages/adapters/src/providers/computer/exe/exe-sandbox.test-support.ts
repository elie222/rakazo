import { parse } from "shell-quote";
import type { ExecOutput } from "../../../computers/sandbox/exec-computer.test-support.js";
import { execComputerShell } from "../../../computers/sandbox/exec-computer.test-support.js";
import { EXEC_WRAPPER } from "./exe-boot.js";
import type { ExeClient, ExeCreateOptions, ExeRunOptions, ExeVm } from "./exe-client.js";
import type { ExeSandboxOptions } from "./exe-sandbox.js";
import { ExeSandboxProvider } from "./exe-sandbox.js";

/** Runs one command in the fake: `hang` waits until the client aborts it. */
export type Runner = (command: string[], input: Buffer) => ExecOutput | "hang";

export interface Vm extends ExeVm {
  status: string;
  created?: ExeCreateOptions;
  /** How many times the boot script ran on it. */
  boots: number;
}

export interface Run {
  name: string;
  command: string[];
  input?: Buffer;
  aborted: boolean;
}

export function vm(name: string, botId = "bot-a", tags = ["rakazo"], status = "running"): Vm {
  return {
    name,
    host: `${name}.exe.xyz`,
    status,
    comment: `rakazo computer for bot ${botId}`,
    tags,
    boots: 0,
  };
}

/** exe.dev's HTTPS API in memory, answering as the real one was seen to. */
export class FakeExe implements ExeClient {
  readonly vms = new Map<string, Vm>();
  /** Each API call, as `verb name`. */
  readonly calls: string[] = [];
  readonly runs: Run[] = [];
  /** Lets a test fail or change a call before it is answered. */
  onCall?: (call: string) => void;
  failBoot?: string;
  /** The tag a tag-scoped key puts on every VM it creates. */
  keyTag?: string;

  constructor(private readonly runner: Runner = () => ({})) {}

  async list(signal: AbortSignal): Promise<ExeVm[]> {
    this.call("ls", signal);
    return [...this.vms.values()].map((entry) => structuredClone(entry));
  }

  async get(name: string, signal: AbortSignal): Promise<ExeVm | undefined> {
    this.call(`ls ${name}`, signal);
    const entry = this.vms.get(name);
    return entry && structuredClone(entry);
  }

  async create(options: ExeCreateOptions, signal: AbortSignal): Promise<ExeVm> {
    this.call(`new ${options.name}`, signal);
    if (this.vms.has(options.name)) throw new Error(`VM name ${options.name} is taken`);
    const tags = [options.tag, this.keyTag].filter((tag): tag is string => !!tag);
    const created: Vm = {
      ...vm(options.name, "", [...new Set(tags)]),
      comment: options.comment,
      created: options,
    };
    this.vms.set(options.name, created);
    return structuredClone(created);
  }

  async remove(name: string, signal: AbortSignal): Promise<void> {
    this.call(`rm ${name}`, signal);
    this.vms.delete(name);
  }

  run(name: string, script: string, options: ExeRunOptions): Promise<number> {
    this.call(`ssh ${name}`, options.signal);
    const target = this.vms.get(name);
    if (target?.status !== "running") {
      return Promise.reject(
        new Error(`exe.dev API error (422) during ssh: VM "${name}" is not running`),
      );
    }
    const run: Run = {
      name,
      command: parse(script).map(String),
      input: options.stdin && Buffer.from(options.stdin),
      aborted: false,
    };
    this.runs.push(run);
    if (run.command[0] !== EXEC_WRAPPER) {
      target.boots += 1;
      if (this.failBoot) options.stderr(Buffer.from(this.failBoot));
      return Promise.resolve(this.failBoot ? 1 : 0);
    }
    const result = this.runner(run.command.slice(1), run.input ?? Buffer.alloc(0));
    if (result === "hang") {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => {
            run.aborted = true;
            reject(options.signal.reason);
          },
          { once: true },
        );
      });
    }
    if (result.stdout?.length) options.stdout(Buffer.from(result.stdout));
    if (result.stderr?.length) options.stderr(Buffer.from(result.stderr));
    return Promise.resolve(result.code ?? 0);
  }

  async vmToken(name: string, expiresAt: number, signal: AbortSignal): Promise<string> {
    this.call(`token ${name}`, signal);
    return `token:${name}:${expiresAt}`;
  }

  private call(call: string, signal: AbortSignal) {
    signal.throwIfAborted();
    this.calls.push(call);
    this.onCall?.(call);
  }
}

export function providerFor(
  fake = new FakeExe(),
  options: Partial<ExeSandboxOptions> = {},
): ExeSandboxProvider {
  return new ExeSandboxProvider(options, fake);
}

/** The real exe.dev adapter over the in-memory API, running commands in the shared shell. */
export function emulatedExe() {
  const shell = execComputerShell();
  const fake = new FakeExe((command, input) => shell.run(command, input));
  return { fake, provider: providerFor(fake) };
}
