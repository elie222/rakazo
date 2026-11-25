import { randomBytes } from "node:crypto";
import type { ExedevClient as Sdk, VM } from "@exedev/sdk";

/** Lifetime of the API tokens Rakazo signs with an SSH key; a fresh one is signed before it ends. */
const SIGNED_TOKEN_MS = 60 * 60_000;
const SIGNED_TOKEN_RENEW_MS = 5 * 60_000;
/** The commands Rakazo runs: the ones a key for it needs. */
const COMMANDS = ["new", "ls", "ssh", "rm"];
/**
 * With an API token, exe.dev issues each VM's token, adding a key to the account each time: one
 * lasts a day and serves every screen of that VM until it is close to its end.
 */
const ISSUED_VM_TOKEN_HOURS = 24;

export interface ExeVm {
  name: string;
  status?: string;
  comment?: string;
  tags: readonly string[];
  /** The host name of the VM's HTTPS proxy. */
  host: string;
}

export interface ExeCreateOptions {
  name: string;
  image: string;
  tag?: string;
  comment: string;
  cpus?: number;
  memory?: string;
}

export interface ExeRunOptions {
  /** Given to the script on its standard input. */
  stdin?: Uint8Array;
  signal: AbortSignal;
  stdout(data: Buffer): void;
  stderr(data: Buffer): void;
}

/** What the provider needs from exe.dev's HTTPS API. */
export interface ExeClient {
  list(signal: AbortSignal): Promise<ExeVm[]>;
  get(name: string, signal: AbortSignal): Promise<ExeVm | undefined>;
  create(options: ExeCreateOptions, signal: AbortSignal): Promise<ExeVm>;
  /** Deletes the VM; one that does not exist counts as deleted. */
  remove(name: string, signal: AbortSignal): Promise<void>;
  /** Runs a shell script on the VM as its login user and resolves to its exit status. */
  run(name: string, script: string, options: ExeRunOptions): Promise<number>;
  /** A bearer token for the VM's HTTPS proxy, valid until `expiresAt` (unix seconds). */
  vmToken(name: string, expiresAt: number, signal: AbortSignal): Promise<string>;
}

type SdkModule = typeof import("@exedev/sdk");

/**
 * exe.dev's HTTPS API through its SDK, with either kind of key: an API token
 * (`ssh-key generate-api-key`), or the private half of an SSH key on the account, which signs
 * short-lived API tokens and the VMs' tokens locally.
 */
export class ExeSdkClient implements ExeClient {
  private signed: { sdk: Sdk; renewAt: number } | undefined;
  private readonly vmTokens = new Map<string, { token: string; expiresAt: number }>();

  private constructor(
    private readonly module: SdkModule,
    private readonly key: { token: string } | { privateKey: string },
    private readonly fetch: typeof globalThis.fetch | undefined,
  ) {}

  /** `fetch` is for tests. */
  static async create(key: string, fetch?: typeof globalThis.fetch): Promise<ExeSdkClient> {
    // Loaded only when this provider is configured.
    const module = await import("@exedev/sdk");
    const client = new ExeSdkClient(module, parseKey(key), fetch);
    // A key that cannot sign fails at startup rather than at the first computer.
    await client.sdk();
    return client;
  }

  async list(signal: AbortSignal): Promise<ExeVm[]> {
    return (await (await this.sdk()).ls(undefined, { signal })).map(toVm);
  }

  async get(name: string, signal: AbortSignal): Promise<ExeVm | undefined> {
    const vms = await (await this.sdk()).ls(name, { signal });
    const vm = vms.find((entry) => entry.name === name);
    return vm && toVm(vm);
  }

  async create(options: ExeCreateOptions, signal: AbortSignal): Promise<ExeVm> {
    const vm = await (await this.sdk()).new({
      name: options.name,
      image: options.image,
      sandbox: true,
      "no-email": true,
      comment: options.comment,
      ...(options.tag ? { tag: options.tag } : {}),
      ...(options.cpus ? { cpu: options.cpus } : {}),
      ...(options.memory ? { memory: options.memory } : {}),
      // The provider waits for the computer itself, which takes longer than SSH.
      waitUntil: "created",
      signal,
    });
    return toVm(vm);
  }

  async remove(name: string, signal: AbortSignal): Promise<void> {
    this.vmTokens.delete(name);
    const result = await (await this.sdk()).rm([name], { signal });
    if (result.deleted.includes(name) || result.not_found?.includes(name)) return;
    throw new Error(`exe.dev did not delete ${name}: ${result.errors?.[name] ?? "unknown error"}`);
  }

  async run(name: string, script: string, options: ExeRunOptions): Promise<number> {
    const vm = (await this.sdk()).vm(name);
    const { signal } = options;
    if (!options.stdin) return this.ssh(vm, script, options);
    // The API has no standard input: the input goes to a private file first.
    const input = `/run/rakazo-input-${randomBytes(8).toString("hex")}`;
    await vm.writeFile(input, options.stdin, { mode: 0o600, signal });
    return this.ssh(vm, `(${script}) <${input}; status=$?; rm -f ${input}; exit $status`, options);
  }

  async vmToken(name: string, expiresAt: number, signal: AbortSignal): Promise<string> {
    if ("privateKey" in this.key) {
      return this.module.signToken({
        privateKey: this.key.privateKey,
        vm: name,
        permissions: { exp: expiresAt },
      });
    }
    const cached = this.vmTokens.get(name);
    if (cached && cached.expiresAt >= expiresAt) return cached.token;
    const hours = Math.max(
      ISSUED_VM_TOKEN_HOURS,
      Math.ceil((expiresAt * 1000 - Date.now()) / 3_600_000),
    );
    const issuedAt = Date.now();
    const sdk = await this.sdk();
    const command = `ssh-key generate-api-key --vm=${name} --label=rakazo-screen-${name} --exp=${hours}h`;
    const result = (await sdk.exec(command, { signal })) as { token?: string };
    if (!result?.token) throw new Error(`exe.dev did not issue a token for ${name}`);
    this.vmTokens.set(name, {
      token: result.token,
      expiresAt: Math.floor(issuedAt / 1000) + hours * 3600,
    });
    return result.token;
  }

  private async ssh(vm: VM, script: string, options: ExeRunOptions): Promise<number> {
    const result = await vm.ssh(script, {
      capture: false,
      signal: options.signal,
      onStdoutBytes: (data) => options.stdout(Buffer.from(data)),
      onStderrBytes: (data) => options.stderr(Buffer.from(data)),
    });
    return result.exitCode;
  }

  private async sdk(): Promise<Sdk> {
    if ("token" in this.key) {
      this.signed ??= {
        sdk: this.connect(this.key.token),
        renewAt: Number.POSITIVE_INFINITY,
      };
      return this.signed.sdk;
    }
    if (this.signed && Date.now() < this.signed.renewAt) return this.signed.sdk;
    const now = Date.now();
    const token = await this.module.signToken({
      privateKey: this.key.privateKey,
      permissions: { exp: Math.floor((now + SIGNED_TOKEN_MS) / 1000), cmds: COMMANDS },
    });
    const sdk = this.connect(token);
    this.signed = { sdk, renewAt: now + SIGNED_TOKEN_MS - SIGNED_TOKEN_RENEW_MS };
    return sdk;
  }

  private connect(token: string): Sdk {
    return this.module.exedev({ token, userAgent: userAgent(), fetch: this.fetch });
  }
}

/**
 * An API token is one line. A private key may come with its line breaks, with `\n` escapes, or
 * with none at all, as `tr -d '\n'` leaves it for a one-line environment variable.
 */
export function parseKey(value: string): { token: string } | { privateKey: string } {
  const key = value.replace(/\\n/g, "\n").trim();
  const armored = /^-----BEGIN ([A-Z ]+)-----(.*?)-----END \1-----$/s.exec(key);
  if (armored) {
    const body = armored[2]!.replace(/\s+/g, "");
    const lines = body.match(/.{1,70}/g) ?? [];
    return {
      privateKey: `-----BEGIN ${armored[1]}-----\n${lines.join("\n")}\n-----END ${armored[1]}-----\n`,
    };
  }
  if (/^exe[01]\.[\w.-]+$/.test(key)) return { token: key };
  throw new Error("EXE_SANDBOX_KEY must be an exe.dev API token or an SSH private key");
}

/**
 * `rakazo/<revision>`: the commit the image was built from, which health reports too, since images
 * carry no release version. The SDK appends its own name and version.
 */
export function userAgent(gitSha = process.env.GIT_SHA ?? process.env.RAKAZO_GIT_SHA): string {
  const revision = gitSha?.trim();
  return revision && revision !== "unknown" ? `rakazo/${revision.slice(0, 12)}` : "rakazo";
}

function toVm(vm: VM): ExeVm {
  return {
    name: vm.name,
    status: vm.info.status,
    comment: vm.info.comment,
    tags: vm.tags,
    host: vm.httpsUrl ? new URL(vm.httpsUrl).hostname : `${vm.name}.exe.xyz`,
  };
}
