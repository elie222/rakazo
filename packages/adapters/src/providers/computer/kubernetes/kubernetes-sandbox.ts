import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import type * as KubernetesClient from "@kubernetes/client-node";
import type {
  ConfigurationOptions,
  CoreV1Api,
  Exec,
  V1Pod,
  V1PodSpec,
  V1Status,
} from "@kubernetes/client-node";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { COMPUTER_CACHE_ENV } from "@rakazo/core/node/desktop-runtime";
import { bestEffort } from "@rakazo/logging";
import type { RawExecEvent } from "../../../computers/sandbox/exec-computer.js";
import {
  RawExecChannel,
  COMPUTER_IMAGE_WORKSPACE as WORKSPACE,
} from "../../../computers/sandbox/exec-computer.js";
import {
  ImageComputerSandbox,
  READY_PORT,
} from "../../../computers/sandbox/image-computer-sandbox.js";
import { deleteUnreferencedMachine } from "../../../computers/sandbox/sandbox-cleanup.js";
import { sandboxNotFoundError } from "../../../computers/sandbox/sandbox-errors.js";

const DEFAULT_NAMESPACE = "rakazo-sandboxes";
// The Compose stack's default image. Pin a digest with KUBERNETES_SANDBOX_COMPUTER_IMAGE in
// production so every pod runs the image the API was tested against.
const DEFAULT_COMPUTER_IMAGE = "ghcr.io/elie222/rakazo/computer:edge";
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CONTAINER_NAME = "computer";
// Names the bot that owns a computer pod. A pod carrying another bot's value is
// never reused or replaced.
const BOT_ID_LABEL = "rakazo-bot-id";
const HOME_VOLUME = "home";
export interface KubernetesSandboxOptions {
  namespace?: string;
  runtimeClassName?: string;
  computerImage?: string;
  cpuLimit?: string;
  memoryLimit?: string;
  podAnnotations?: Record<string, string>;
  podLabels?: Record<string, string>;
  readyTimeoutMs?: number;
  /**
   * Claim in the sandbox namespace that holds the Rakazo data directory. When
   * set, each Computer mounts only its own `homes/<bot id>` directory at the
   * workspace, so the home persists in place and is never copied in or out.
   * The claim's volume is ReadWriteOnce, so the pod must also be placed with
   * the pods named by `homeColocateNamespace` and `homeColocateLabels`.
   */
  homeClaim?: string;
  homeColocateNamespace?: string;
  homeColocateLabels?: Record<string, string>;
}

export interface KubernetesSandboxSdk {
  core: Pick<CoreV1Api, "createNamespacedPod" | "deleteNamespacedPod" | "readNamespacedPod">;
  exec: Pick<Exec, "exec">;
}

export class KubernetesSandboxProvider extends ImageComputerSandbox {
  private readonly namespace: string;
  private readonly runtimeClassName: string | undefined;
  private readonly computerImage: string;
  private readonly cpuLimit: string | undefined;
  private readonly memoryLimit: string | undefined;
  private readonly podAnnotations: Record<string, string>;
  private readonly podLabels: Record<string, string>;
  private readonly readyTimeoutMs: number;
  private readonly homeClaim: string | undefined;
  private readonly homeColocateNamespace: string | undefined;
  private readonly homeColocateLabels: Record<string, string>;
  private clientsValue: KubernetesSandboxSdk | undefined;

  constructor(options: KubernetesSandboxOptions = {}, clients?: KubernetesSandboxSdk) {
    super("kubernetes", "Kubernetes");
    this.namespace = options.namespace?.trim() || DEFAULT_NAMESPACE;
    this.runtimeClassName = options.runtimeClassName?.trim() || undefined;
    this.computerImage = options.computerImage?.trim() || DEFAULT_COMPUTER_IMAGE;
    this.cpuLimit = options.cpuLimit?.trim() || undefined;
    this.memoryLimit = options.memoryLimit?.trim() || undefined;
    this.podAnnotations = { ...options.podAnnotations };
    this.podLabels = { ...options.podLabels };
    this.readyTimeoutMs = positiveInteger(options.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS);
    this.homeClaim = options.homeClaim?.trim() || undefined;
    this.homeColocateNamespace = options.homeColocateNamespace?.trim() || undefined;
    this.homeColocateLabels = { ...options.homeColocateLabels };
    if (
      this.homeClaim &&
      (!this.homeColocateNamespace || Object.keys(this.homeColocateLabels).length === 0)
    ) {
      throw new Error("a mounted Kubernetes home requires a pod-affinity namespace and labels");
    }
    this.clientsValue = clients;
  }

  protected override persistentHome(): boolean {
    return this.homeClaim !== undefined;
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
    context.signal.throwIfAborted();
    const podName =
      request.providerKind === "kubernetes" && request.providerRef
        ? request.providerRef
        : podNameForBot(request.botId);
    let pod = await this.readPod(podName, context.signal);
    if (pod && pod.metadata?.labels?.[BOT_ID_LABEL] !== request.botId) {
      throw new Error(`Kubernetes pod ${podName} belongs to another bot`);
    }

    if (pod?.metadata?.deletionTimestamp) {
      await this.waitForDeletion(podName, context.signal);
      pod = undefined;
    }

    // Keep an unmounted live pod until the normal checkpoint and stop save its files.
    // The next fresh pod will mount that saved home.
    if (pod && isTerminalPod(pod)) {
      await this.deletePod(podName);
      await this.waitForDeletion(podName, context.signal);
      pod = undefined;
    }

    let fresh = false;
    try {
      if (!pod) {
        try {
          await this.request(context.signal, (core, options) =>
            core.createNamespacedPod(
              { namespace: this.namespace, body: this.pod(podName, request.botId) },
              options,
            ),
          );
          fresh = true;
        } catch (error) {
          if (!isApiStatus(error, 409)) {
            // A failed request can still have created the pod. Reconcile independently of
            // run cancellation so an accepted create enters the normal failed-start cleanup.
            const accepted = await bestEffort(
              "reconcile a failed Kubernetes pod create",
              this.readPod(podName, AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
            );
            fresh = accepted?.metadata?.labels?.[BOT_ID_LABEL] === request.botId;
            throw error;
          }
          const existing = await this.readPod(podName, context.signal);
          if (existing?.metadata?.labels?.[BOT_ID_LABEL] !== request.botId) {
            throw new Error(`Kubernetes pod ${podName} belongs to another bot`);
          }
        }
      }

      await this.waitForReady(podName, context.signal);
    } catch (error) {
      if (fresh) {
        // Not recorded for a later delete: the pod carries its bot's fixed name, so that bot's
        // next start reuses or deletes it, and a late delete by name could take the pod that
        // start is reusing.
        await deleteUnreferencedMachine(
          undefined,
          { provider: "kubernetes", machineId: podName },
          (signal) => this.deletePod(podName, signal),
        );
      }
      throw error;
    }
    return {
      id: podName,
      botId: request.botId,
      kind: "kubernetes",
      providerRef: podName,
      fresh,
    };
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    if (computer.kind !== "kubernetes") return false;
    const pod = await this.readPod(this.podId(computer), context.signal);
    return pod?.status?.phase === "Running" && !pod.metadata?.deletionTimestamp;
  }

  async hasMountedHome(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    if (computer.kind !== "kubernetes") return false;
    // Checked even with no claim configured: a pod started with one still mounts the home
    // until it stops, and exporting over that directory would delete its live files.
    const pod = await this.readPod(this.podId(computer), context.signal);
    return !!pod && podMountsHome(pod, computer.botId, this.homeClaim);
  }

  protected async relayBindHost(computer: ComputerRef, context: AdapterContext) {
    const pod = await this.readPod(this.podId(computer), context.signal);
    return pod?.status?.podIP?.includes(":") ? "::" : "0.0.0.0";
  }

  protected async screenAddress(computer: ComputerRef, context: AdapterContext) {
    const pod = await this.readPod(this.podId(computer), context.signal);
    const podIp = pod?.status?.podIP;
    if (!podIp) throw new Error("Kubernetes computer has no pod IP");
    return podIp;
  }

  protected override async screenControlFailure(
    computer: ComputerRef,
    error: unknown,
    context: AdapterContext,
  ): Promise<unknown> {
    let pod: V1Pod | undefined;
    try {
      pod = await this.readPod(this.podId(computer), context.signal);
    } catch {
      return error;
    }
    if (pod && !isTerminalPod(pod) && !pod.metadata?.deletionTimestamp) return error;
    return sandboxGone(this.podId(computer), error);
  }

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    await this.deletePod(this.podId(computer));
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    await this.deletePod(this.podId(computer));
  }

  private async clients(): Promise<KubernetesSandboxSdk> {
    if (this.clientsValue) return this.clientsValue;
    const kubernetes = await loadKubernetes();
    if (this.clientsValue) return this.clientsValue;
    const config = new kubernetes.KubeConfig();
    config.loadFromDefault();
    this.clientsValue = {
      core: config.makeApiClient(kubernetes.CoreV1Api),
      exec: new kubernetes.Exec(config),
    };
    return this.clientsValue;
  }

  private pod(name: string, botId: string): V1Pod {
    const limits = {
      ...(this.cpuLimit ? { cpu: this.cpuLimit } : {}),
      ...(this.memoryLimit ? { memory: this.memoryLimit } : {}),
    };
    return {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name,
        namespace: this.namespace,
        annotations: this.podAnnotations,
        labels: {
          ...this.podLabels,
          "app.kubernetes.io/name": "rakazo-computer",
          [BOT_ID_LABEL]: botId,
        },
      },
      spec: {
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        restartPolicy: "Never",
        terminationGracePeriodSeconds: 10,
        ...(this.homeClaim ? this.homeSpec(botId) : {}),
        ...(this.runtimeClassName ? { runtimeClassName: this.runtimeClassName } : {}),
        containers: [
          {
            name: CONTAINER_NAME,
            image: this.computerImage,
            env: [
              ...Object.entries(COMPUTER_CACHE_ENV).map(([name, value]) => ({ name, value })),
              { name: "VNC_RESOLUTION", value: "1280x800" },
            ],
            ports: [{ name: "screen", containerPort: READY_PORT, protocol: "TCP" }],
            // Matches the Docker computer: no capabilities, no privilege escalation, default seccomp.
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
              seccompProfile: { type: "RuntimeDefault" },
            },
            readinessProbe: {
              tcpSocket: { port: READY_PORT },
              initialDelaySeconds: 1,
              periodSeconds: 1,
              timeoutSeconds: 1,
              failureThreshold: Math.ceil(this.readyTimeoutMs / 1_000),
            },
            ...(this.homeClaim
              ? {
                  volumeMounts: [
                    { name: HOME_VOLUME, mountPath: WORKSPACE, subPath: homeSubPath(botId) },
                  ],
                }
              : {}),
            ...(Object.keys(limits).length ? { resources: { limits } } : {}),
          },
        ],
      },
    };
  }

  private homeSpec(botId: string): Pick<V1PodSpec, "volumes" | "securityContext" | "affinity"> {
    homeSubPath(botId);
    return {
      volumes: [{ name: HOME_VOLUME, persistentVolumeClaim: { claimName: this.homeClaim! } }],
      // The Computer image runs as uid 1000, the owner of the application data.
      securityContext: { fsGroup: 1000, fsGroupChangePolicy: "OnRootMismatch" },
      affinity: {
        podAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: [
            {
              namespaces: [this.homeColocateNamespace!],
              labelSelector: { matchLabels: this.homeColocateLabels },
              topologyKey: "kubernetes.io/hostname",
            },
          ],
        },
      },
    };
  }

  private podId(computer: ComputerRef): string {
    return computer.providerRef || computer.id;
  }

  private async readPod(name: string, signal: AbortSignal): Promise<V1Pod | undefined> {
    try {
      return await this.request(signal, (core, options) =>
        core.readNamespacedPod({ name, namespace: this.namespace }, options),
      );
    } catch (error) {
      if (isApiStatus(error, 404)) return undefined;
      throw error;
    }
  }

  private async request<T>(
    signal: AbortSignal,
    call: (core: KubernetesSandboxSdk["core"], options: ConfigurationOptions) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const request = Promise.all([loadKubernetes(), this.clients()]).then(
      ([{ Observable }, clients]) =>
        call(clients.core, {
          middlewareMergeStrategy: "append",
          middleware: [
            {
              pre: (request) => {
                request.setSignal(requestSignal);
                return new Observable(Promise.resolve(request));
              },
              post: (response) => new Observable(Promise.resolve(response)),
            },
          ],
        }),
    );
    const result = await abortableRequest(request, requestSignal);
    signal.throwIfAborted();
    return result;
  }

  private async waitForReady(name: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (true) {
      const pod = await this.readPod(name, signal);
      if (!pod) throw new Error(`Kubernetes pod ${name} disappeared while starting`);
      if (pod.metadata?.deletionTimestamp) throw sandboxGone(name);
      if (isTerminalPod(pod)) {
        throw new Error(`Kubernetes pod ${name} entered phase ${pod.status?.phase ?? "Unknown"}`);
      }
      if (
        pod.status?.phase === "Running" &&
        pod.status.conditions?.some(
          (condition) => condition.type === "Ready" && condition.status === "True",
        )
      ) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Kubernetes pod ${name} did not become ready within ${this.readyTimeoutMs} ms`,
        );
      }
      await abortableDelay(500, signal);
    }
  }

  private async waitForDeletion(name: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (await this.readPod(name, signal)) {
      if (Date.now() >= deadline) throw new Error(`Kubernetes pod ${name} was not deleted`);
      await abortableDelay(500, signal);
    }
  }

  /** Cancellation must not skip cleanup, so a caller passes only a deadline of its own. */
  private async deletePod(
    name: string,
    signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ): Promise<void> {
    try {
      await this.request(signal, (core, options) =>
        core.deleteNamespacedPod(
          {
            name,
            namespace: this.namespace,
            gracePeriodSeconds: 0,
            propagationPolicy: "Background",
          },
          options,
        ),
      );
    } catch (error) {
      if (!isApiStatus(error, 404)) throw error;
    }
  }

  protected async *execRaw(
    computer: ComputerRef,
    command: string[],
    signal: AbortSignal,
    timeoutMs: number,
    stdin?: Readable,
    tty = false,
  ): AsyncIterable<RawExecEvent> {
    let socket: Awaited<ReturnType<KubernetesSandboxSdk["exec"]["exec"]>> | undefined;
    const channel = new RawExecChannel(signal, timeoutMs, () => socket?.close());
    const stdout = new PassThrough();
    const stderr = tty ? undefined : new PassThrough();
    stdout.on("data", (data: Buffer) => channel.push({ type: "stdout", data: Buffer.from(data) }));
    stderr?.on("data", (data: Buffer) => channel.push({ type: "stderr", data: Buffer.from(data) }));
    const fail = (error: unknown) => channel.fail(error);
    // A failing input stream (for example a workspace iterator that throws)
    // would otherwise leave the exec waiting for input until the timeout.
    stdin?.on("error", fail);
    try {
      if (!channel.done) {
        const connecting = this.clients().then((clients) =>
          clients.exec.exec(
            this.namespace,
            this.podId(computer),
            CONTAINER_NAME,
            command,
            stdout,
            stderr ?? null,
            stdin ?? null,
            tty,
            (status) => channel.finish(exitCode(status)),
          ),
        );
        await Promise.race([
          connecting.then(
            (connected) => {
              socket = connected;
              if (channel.done) {
                connected.close();
                return;
              }
              connected.onclose = () => channel.finish(1);
              connected.onerror = (event) => fail(execSocketError(event));
            },
            (event) => fail(execSocketError(event)),
          ),
          channel.settled,
        ]);
      }
      yield* channel.drain();
      const { failure } = channel;
      if (failure) {
        if (failure instanceof Error && /Unexpected server response: 404\b/.test(failure.message)) {
          let pod: V1Pod | undefined;
          try {
            pod = await this.readPod(this.podId(computer), signal);
          } catch {
            throw failure;
          }
          if (!pod || isTerminalPod(pod) || pod.metadata?.deletionTimestamp) {
            throw sandboxGone(this.podId(computer), failure);
          }
        }
        throw failure;
      }
    } finally {
      channel.close();
      socket?.close();
      stdin?.destroy();
      stdout.destroy();
      stderr?.destroy();
    }
  }
}

/** A socket reports failure with an event whose fields are not enumerable, so it logs as `{}`. */
function execSocketError(event: unknown): unknown {
  const { error, message } = event as { error?: unknown; message?: string };
  return event instanceof Error ? event : (error ?? new Error(message || "Kubernetes exec failed"));
}

let kubernetesModule: Promise<typeof KubernetesClient> | undefined;

/** Deferred so deployments that never select this provider do not load the SDK at boot. */
function loadKubernetes(): Promise<typeof KubernetesClient> {
  kubernetesModule ??= import("@kubernetes/client-node");
  return kubernetesModule;
}

function podNameForBot(botId: string): string {
  const normalized = botId
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 40);
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 12);
  return `rakazo-${normalized || "bot"}-${hash}`;
}

/** The data directory holds `homes/<bot id>`; a bot id must name exactly one folder. */
function homeSubPath(botId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(botId)) throw new Error("invalid bot id for a mounted home");
  return `homes/${botId}`;
}

/** With no claim configured, any claim counts, so pods started with one keep their mount. */
function podMountsHome(pod: V1Pod, homeKey: string, claimName: string | undefined): boolean {
  const claims = new Set(
    pod.spec?.volumes?.flatMap((entry) => {
      const claim = entry.persistentVolumeClaim?.claimName;
      return claim && (!claimName || claim === claimName) ? [entry.name] : [];
    }),
  );
  const container = pod.spec?.containers?.find((entry) => entry.name === CONTAINER_NAME);
  return (
    container?.volumeMounts?.some(
      (mount) =>
        claims.has(mount.name) &&
        mount.mountPath === WORKSPACE &&
        mount.subPath === `homes/${homeKey}`,
    ) === true
  );
}

function sandboxGone(name: string, cause?: unknown): Error {
  return sandboxNotFoundError(`Kubernetes computer ${name} no longer exists`, { cause });
}

function isTerminalPod(pod: V1Pod): boolean {
  return pod.status?.phase === "Failed" || pod.status?.phase === "Succeeded";
}

function exitCode(status: V1Status): number {
  if (status.status === "Success") return 0;
  const cause = status.details?.causes?.find((entry) => entry.reason === "ExitCode");
  const code = Number(cause?.message);
  return Number.isSafeInteger(code) && code >= 0 && code <= 255 ? code : 1;
}

function isApiStatus(error: unknown, code: number): boolean {
  // ApiException carries the HTTP status as `code`.
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

/** Bound setup as well as transport, including authentication before the HTTP request starts. */
function abortableRequest<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Kubernetes request aborted"));
    signal.addEventListener("abort", abort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => done(signal.reason ?? new Error("Kubernetes operation aborted"));
    function done(error?: unknown) {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
