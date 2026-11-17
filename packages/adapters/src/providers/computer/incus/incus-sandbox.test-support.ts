import { withAbort } from "@rakazo/core";
import { deferred } from "@rakazo/core/test-async";
import { expect, vi } from "vitest";
import type { ExecOutput } from "../../../exec-computer.test-support.js";
import { execComputerShell } from "../../../exec-computer.test-support.js";
import type {
  IncusClient,
  IncusResponse,
  IncusSocket,
  IncusSocketHandlers,
} from "./incus-sandbox.js";
import { IncusError, IncusSandboxProvider } from "./incus-sandbox.js";

/** Runs one exec in the fake: `hang` waits until the client signals or closes the command. */
export type Runner = (command: string[], input: Buffer, tty: boolean) => ExecOutput | "hang";

export interface Instance {
  status: string;
  ephemeral: boolean;
  config: Record<string, string>;
  state?: {
    network: Record<string, { addresses: { family: string; address: string; scope: string }[] }>;
  };
}

export interface Exec {
  command: string[];
  body: Record<string, unknown>;
  signals: number[];
  input: Buffer[];
  inputClosed: boolean;
  closed: Set<string>;
  handlers: Map<string, IncusSocketHandlers>;
  finish: (code: number) => void;
}

export function running(botId = "bot-a", address = "10.0.0.8"): Instance {
  return {
    status: "Running",
    ephemeral: true,
    config: { "user.rakazo-bot-id": botId },
    state: {
      network: {
        lo: { addresses: [{ family: "inet", address: "127.0.0.1", scope: "local" }] },
        eth0: {
          addresses: [
            { family: address.includes(":") ? "inet6" : "inet", address, scope: "global" },
            { family: "inet6", address: "fe80::1", scope: "link" },
          ],
        },
      },
    },
  };
}

/** An in-memory Incus API with the behaviour the provider relies on, as observed on Incus 7. */
export class FakeIncus implements IncusClient {
  readonly instances = new Map<string, Instance>();
  readonly requests: { method: string; path: string; body: unknown }[] = [];
  readonly execs: Exec[] = [];
  /** Lets a test change an instance between the provider's reads. */
  onRead?: (name: string) => void;
  failCreate?: (name: string) => void;
  /** Creates the instance, then fails the operation, as a start that fails does. */
  failStart?: boolean;
  /** Holds instance creation until it settles, as an image download does. */
  createGate?: Promise<void>;
  /** Holds an exec's control stream; Incus starts the command without it. */
  controlGate?: Promise<void>;
  private readonly operations = new Map<string, Promise<Record<string, unknown>>>();
  /** Operations still creating an instance, by id, as Incus lists them. */
  private readonly creating = new Map<string, string>();
  private readonly secrets = new Map<string, { exec: Exec; fd: string }>();
  private next = 0;

  constructor(private readonly runner: Runner = () => ({})) {}

  async request(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<IncusResponse> {
    signal.throwIfAborted();
    this.requests.push({ method, path, body });
    const url = new URL(path, "https://incus.test");
    const parts = url.pathname.split("/").slice(2).map(decodeURIComponent);
    if (parts[0] === "operations" && parts[2] === "wait") {
      return { metadata: await withAbort(this.operations.get(parts[1]!)!, signal) };
    }
    if (parts[0] === "operations" && !parts[1]) {
      const running = [...this.creating].map(([id, name]) => ({
        id,
        status_code: 103,
        resources: { instances: [`/1.0/instances/${name}?project=default`] },
      }));
      return { metadata: { running } };
    }
    if (parts[0] !== "instances") throw new IncusError("not found", 404);
    const name = parts[1];
    if (method === "GET" && !name) {
      const [, botId] =
        /^config\.user\.rakazo-bot-id eq (\S+)$/.exec(url.searchParams.get("filter") ?? "") ?? [];
      return {
        metadata: [...this.instances]
          .filter(([, instance]) => instance.config["user.rakazo-bot-id"] === botId)
          .map(([instanceName, instance]) => ({
            name: instanceName,
            ...structuredClone(instance),
          })),
      };
    }
    if (method === "POST" && !name) return this.create(body as Record<string, unknown>);
    if (!name) throw new IncusError("not found", 404);
    this.onRead?.(name);
    const instance = this.instances.get(name);
    if (!instance)
      throw new IncusError(`Failed to fetch instance "${name}": Instance not found`, 404);
    if (method === "GET" && !parts[2]) return { metadata: { name, ...structuredClone(instance) } };
    if (method === "PUT" && parts[2] === "state") {
      if (instance.status !== "Running")
        throw new IncusError("The instance is already stopped", 400);
      if (instance.ephemeral) this.instances.delete(name);
      else instance.status = "Stopped";
      return this.operation(Promise.resolve({ status: "Success", status_code: 200 }));
    }
    if (method === "DELETE" && !parts[2]) {
      if (instance.status === "Running") throw new IncusError("Instance is running", 400);
      this.instances.delete(name);
      return this.operation(Promise.resolve({ status: "Success", status_code: 200 }));
    }
    if (method === "POST" && parts[2] === "exec") {
      if (instance.status !== "Running") throw new IncusError("Instance is not running", 400);
      return this.exec(body as Record<string, unknown>);
    }
    throw new IncusError("not implemented", 501);
  }

  async websocket(path: string, handlers: IncusSocketHandlers): Promise<IncusSocket> {
    const url = new URL(path, "https://incus.test");
    this.requests.push({ method: "WEBSOCKET", path, body: undefined });
    const entry = this.secrets.get(url.searchParams.get("secret") ?? "");
    if (!entry) throw new Error("unknown websocket secret");
    const { exec, fd } = entry;
    if (fd === "control") await this.controlGate;
    exec.handlers.set(fd, handlers);
    queueMicrotask(() => this.maybeStart(exec));
    return {
      send: async (data) => {
        if (fd === "control") exec.signals.push(JSON.parse(String(data)).signal);
        else exec.input.push(Buffer.from(data));
        if (fd === "control") exec.finish(128 + exec.signals.at(-1)!);
      },
      close: () => {
        if (exec.closed.has(fd)) return;
        exec.closed.add(fd);
        if (fd === "0") {
          exec.inputClosed = true;
          this.maybeStart(exec);
        }
      },
    };
  }

  private create(body: Record<string, unknown>): IncusResponse {
    const name = String(body.name);
    if (this.instances.has(name)) throw new IncusError(`Instance "${name}" already exists`, 500);
    this.failCreate?.(name);
    const config = body.config as Record<string, string>;
    const created = (this.createGate ?? Promise.resolve()).then(() => {
      this.instances.set(name, {
        ...running(config["user.rakazo-bot-id"]),
        ...(this.failStart ? { status: "Stopped" } : {}),
        config: { ...config },
      });
      return this.failStart
        ? { status: "Failure", status_code: 400, err: "Failed to start instance" }
        : { status: "Success", status_code: 200 };
    });
    const response = this.operation(created);
    const id = response.operation!.split("/").pop()!;
    this.creating.set(id, name);
    void created.finally(() => this.creating.delete(id));
    return response;
  }

  private exec(body: Record<string, unknown>): IncusResponse {
    const tty = body.interactive === true;
    const done = deferred<number>();
    const exec: Exec = {
      command: body.command as string[],
      body,
      signals: [],
      input: [],
      inputClosed: false,
      closed: new Set(),
      handlers: new Map(),
      finish: (code) => done.resolve(code),
    };
    this.execs.push(exec);
    const fds = Object.fromEntries(
      (tty ? ["0", "control"] : ["0", "1", "2", "control"]).map((fd) => {
        const secret = `secret-${this.next++}`;
        this.secrets.set(secret, { exec, fd });
        return [fd, secret];
      }),
    );
    const finished = done.promise.then(async (code) => {
      // An interactive command ends only once the client closes its stream.
      if (tty) await vi.waitFor(() => expect(exec.closed.has("0")).toBe(true));
      return { status: "Success", status_code: 200, metadata: { return: code } };
    });
    return { ...this.operation(finished), metadata: { metadata: { fds } } };
  }

  private started = new WeakSet<Exec>();

  private maybeStart(exec: Exec) {
    const tty = exec.body.interactive === true;
    const required = tty ? ["0"] : ["0", "1", "2"];
    if (!required.every((fd) => exec.handlers.has(fd))) return;
    if (!tty && !exec.inputClosed) return;
    if (this.started.has(exec)) return;
    this.started.add(exec);
    const result = this.runner(exec.command, Buffer.concat(exec.input), tty);
    if (result === "hang") return;
    const emit = (fd: string, data: string | Buffer | undefined) => {
      if (data?.length) exec.handlers.get(fd)?.message(Buffer.from(data), true);
    };
    if (tty) {
      emit("0", result.stdout);
      exec.handlers.get("0")?.message(Buffer.alloc(0), false);
    } else {
      emit("1", result.stdout);
      emit("2", result.stderr);
      exec.handlers.get("1")?.close();
      exec.handlers.get("2")?.close();
    }
    exec.finish(result.code ?? 0);
  }

  private operation(result: Promise<Record<string, unknown>>): IncusResponse {
    const id = `op-${this.next++}`;
    this.operations.set(id, result);
    return { metadata: {}, operation: `/1.0/operations/${id}` };
  }
}

export function providerFor(
  fake = new FakeIncus(),
  options: Partial<ConstructorParameters<typeof IncusSandboxProvider>[0]> = {},
) {
  return new IncusSandboxProvider(
    { url: "https://incus.test:8443", clientCert: "cert", clientKey: "key", ...options },
    fake,
  );
}

/** The real Incus adapter over the in-memory API, running commands in the shared exec shell. */
export function emulatedIncus() {
  const shell = execComputerShell();
  const fake = new FakeIncus((command, input) => shell.run(command, input));
  return { fake, provider: providerFor(fake) };
}
