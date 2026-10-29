import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import type * as KubernetesClient from "@kubernetes/client-node";
import type { CoreV1Api, Exec, V1Pod, V1PodSpec, V1Status } from "@kubernetes/client-node";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
  TerminalRequest,
} from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import { COMPUTER_CACHE_ENV } from "@rakazo/core/node/desktop-runtime";
import { normalizeWorkspacePath, shellQuote, workspacePath } from "./computer-support.js";
import { LinuxDesktop, onBotScreen } from "./linux-desktop.js";
import { sandboxCommandArgv } from "./sandbox-command-environment.js";
import {
  shouldSkipPortableWorkspaceFile,
  workspaceSaveFindExpression,
} from "./workspace-save-policy.js";

const DISPLAY_START = 20;
const DEFAULT_NAMESPACE = "rakazo-sandboxes";
// Same default as the Compose stack. Pin a digest with KUBERNETES_SANDBOX_COMPUTER_IMAGE in
// production so every pod runs the image the API was tested against.
const DEFAULT_COMPUTER_IMAGE = "ghcr.io/elie222/rakazo/computer:edge";
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const WORKSPACE = "/home/rakazo";
const CONTAINER_NAME = "computer";
// Names the bot that owns a computer pod. A pod carrying another bot's value is
// never reused or replaced.
const BOT_ID_LABEL = "rakazo-bot-id";
const HOME_VOLUME = "home";
const READY_PORT = 6080;
const DESKTOP_PORT_START = 6100;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const BULK_TRANSFER_TIMEOUT_MS = 30 * 60_000;

// The pinned Computer image is deliberately immutable at runtime and runs as
// uid 1000 with no privilege escalation. Validate its baked desktop tools
// instead of using the generic sandbox bootstrap, which tries apt via sudo
// when optional scrot is absent. ImageMagick's import is the supported capture
// fallback in this image.
const PREPARE_KUBERNETES_DESKTOP = [
  'missing=""',
  'for command in python3 flock Xvfb xdpyinfo x11vnc fluxbox xdotool wmctrl xterm websockify; do command -v "$command" >/dev/null 2>&1 || missing="$missing $command"; done',
  'if ! command -v scrot >/dev/null 2>&1 && ! command -v import >/dev/null 2>&1; then missing="$missing scrot-or-import"; fi',
  'if [ ! -d /usr/share/novnc ] && [ ! -d /opt/noVNC ]; then missing="$missing novnc"; fi',
  'if [ -n "$missing" ]; then echo "computer image is missing required desktop tools:$missing" >&2; exit 1; fi',
].join("\n");

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

type RawExecEvent = { type: "stdout" | "stderr"; data: Buffer } | { type: "exit"; code: number };

export class KubernetesSandboxProvider implements SandboxProvider {
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

  private readonly desktops = new LinuxDesktop({
    environment: async (computer, context) => {
      const pod = await this.readPod(this.podId(computer), context.signal);
      return {
        homeDir: WORKSPACE,
        workspaceDir: WORKSPACE,
        browserProfilesDir: `${WORKSPACE}/.browser-profiles`,
        displayStart: DISPLAY_START,
        portStart: DESKTOP_PORT_START,
        // The relay must use the address family the web pod connects to.
        bindHost: pod?.status?.podIP?.includes(":") ? "::" : "0.0.0.0",
      };
    },
    run: async (computer, command, context) => {
      const result = await this.run(computer, ["bash", "-c", command], context);
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    },
    screenUrl: async (computer, port, context) => {
      const pod = await this.readPod(this.podId(computer), context.signal);
      const podIp = pod?.status?.podIP;
      if (!podIp) throw new Error("Kubernetes computer has no pod IP");
      const host = podIp.includes(":") ? `[${podIp}]` : podIp;
      // The web app frames /novnc/ pages with sandbox="allow-scripts", an opaque
      // origin. Stock vnc.html reads localStorage and throws a SecurityError there,
      // leaving a black screen. The image's embed.html is the page the Docker
      // provider serves for the same frame.
      return `http://${host}:${port}/embed.html`;
    },
  });

  constructor(options: KubernetesSandboxOptions = {}, clients?: KubernetesSandboxSdk) {
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

  describe() {
    return {
      id: "kubernetes",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: this.homeClaim !== undefined,
        multiScreen: true,
      },
    };
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
    if (!pod) {
      try {
        await (await this.clients()).core.createNamespacedPod({
          namespace: this.namespace,
          body: this.pod(podName, request.botId),
        });
        fresh = true;
      } catch (error) {
        if (!isApiStatus(error, 409)) throw error;
        const existing = await this.readPod(podName, context.signal);
        if (existing?.metadata?.labels?.[BOT_ID_LABEL] !== request.botId) {
          throw new Error(`Kubernetes pod ${podName} belongs to another bot`);
        }
      }
    }

    try {
      await this.waitForReady(podName, context.signal);
    } catch (error) {
      if (fresh) await this.deletePod(podName).catch(() => undefined);
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

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const command = [
      "set -eu",
      `mkdir -p -- ${shellQuote(WORKSPACE)} ${shellQuote(`${WORKSPACE}/.browser-profiles`)}`,
      PREPARE_KUBERNETES_DESKTOP,
    ].join("\n");
    const result = await this.run(computer, ["bash", "-c", command], context, 300_000);
    if (result.code !== 0) {
      throw new Error(result.stderr || "could not prepare Kubernetes computer");
    }
  }

  async *execute(
    computer: ComputerRef,
    requested: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const request = onBotScreen(requested, context, DISPLAY_START);
    if (context.signal.aborted) {
      yield { type: "stderr", data: "command aborted\n" };
      yield { type: "exit", code: 130 };
      return;
    }
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    const command = commandRequestArgv(request, timeoutMs);
    const decoders = {
      stdout: new TextDecoder(),
      stderr: new TextDecoder(),
    };
    for await (const event of this.execRaw(
      computer,
      command,
      context.signal,
      timeoutMs,
      undefined,
      request.pty === true,
    )) {
      if (event.type === "exit") {
        const stdoutTail = decoders.stdout.decode();
        const stderrTail = decoders.stderr.decode();
        if (stdoutTail) yield { type: "stdout", data: stdoutTail };
        if (stderrTail) yield { type: "stderr", data: stderrTail };
        yield event;
        continue;
      }
      const data = decoders[event.type].decode(event.data, { stream: true });
      if (data) yield { type: event.type, data };
    }
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    return this.desktops.connectScreen(computer, request, context);
  }

  async connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    // The API has already required the live human control token. Attach the
    // terminal to that controlled display without trying to replace the bot
    // run's screen fence: a new chat run may legitimately supersede the fence
    // while the human keeps control of the same persistent Kubernetes pod.
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
      let pod: V1Pod | undefined;
      try {
        pod = await this.readPod(this.podId(computer), context.signal);
      } catch {
        throw error;
      }
      if (pod && !isTerminalPod(pod) && !pod.metadata?.deletionTimestamp) throw error;
      throw sandboxGone(this.podId(computer), error);
    }
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    return this.desktops.sendInput(computer, input, context);
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    return this.desktops.observe(computer, context);
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return this.desktops.act(computer, request, context);
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    return this.desktops.releaseScreen(computer, context);
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const relative = normalizeWorkspacePath(directory);
    const target = workspacePath(WORKSPACE, relative);
    const result = await this.run(
      computer,
      ["find", target, "-mindepth", "1", "-maxdepth", "1", "-printf", "%P\\0%y\\0%s\\0%m\\0"],
      context,
    );
    if (result.code !== 0) throw new Error(result.stderr || "could not list computer files");
    const fields = result.stdout.split("\0");
    const entries: ComputerFileEntry[] = [];
    for (let index = 0; index + 3 < fields.length; index += 4) {
      const name = fields[index];
      const kind = fields[index + 1];
      const size = Number(fields[index + 2]);
      const mode = Number.parseInt(fields[index + 3] ?? "", 8);
      if (!name || (kind !== "d" && kind !== "f") || !Number.isSafeInteger(size)) continue;
      entries.push({
        path: normalizeWorkspacePath(path.posix.join(relative, name)),
        kind: kind === "d" ? "dir" : "file",
        size,
        ...(kind === "f" && (mode & 0o111) !== 0 ? { executable: true } : {}),
      });
    }
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    const target = workspacePath(WORKSPACE, filePath);
    const maxBytes = options?.maxBytes ?? MAX_FILE_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid file size limit");
    const size = await this.run(computer, ["stat", "-c", "%s", "--", target], context);
    if (size.code !== 0) throw new Error(size.stderr || "could not inspect computer file");
    if (Number(size.stdout.trim()) > maxBytes) {
      throw new Error(`computer file exceeds ${maxBytes} bytes`);
    }
    const result = await this.collectExec(computer, ["cat", "--", target], context, maxBytes + 1);
    if (result.code !== 0) {
      throw new Error(result.stderr.toString("utf8") || "could not read computer file");
    }
    if (result.stdout.byteLength > maxBytes) {
      throw new Error(`computer file exceeds ${maxBytes} bytes`);
    }
    return new Uint8Array(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength);
  }

  async writeFile(
    computer: ComputerRef,
    file: PortableFile,
    context: AdapterContext,
  ): Promise<void> {
    const target = workspacePath(WORKSPACE, file.path);
    const command = [
      "bash",
      "-c",
      [
        "set -eu",
        'target="$1"',
        'mode="$2"',
        'directory=$(dirname -- "$target")',
        'mkdir -p -- "$directory"',
        'temporary=$(mktemp "$directory/.rakazo-write.XXXXXX")',
        "trap 'rm -f -- \"$temporary\"' EXIT",
        'cat >"$temporary"',
        'chmod "$mode" -- "$temporary"',
        'mv -f -- "$temporary" "$target"',
        "trap - EXIT",
      ].join("\n"),
      "rakazo-write",
      target,
      file.executable ? "700" : "600",
    ];
    const result = await this.collectExec(
      computer,
      command,
      context,
      1024 * 1024,
      Readable.from(Buffer.from(file.content)),
    );
    if (result.code !== 0) {
      throw new Error(result.stderr.toString("utf8") || "could not write computer file");
    }
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    await this.desktops.stopBrowsers(computer, context);
    // One exec streams the whole home as a tar archive. Per-file execs cost a
    // Kubernetes round trip each, which took minutes for a restored home.
    const listing = await this.run(
      computer,
      [
        "bash",
        "-c",
        `cd ${shellQuote(WORKSPACE)} && find . ${workspaceSaveFindExpression()} -printf '%P\\0'`,
      ],
      context,
    );
    if (listing.code !== 0) {
      throw new Error(listing.stderr || "could not list computer workspace");
    }
    const names = listing.stdout
      .split("\0")
      .filter((name) => name && !shouldSkipPortableWorkspaceFile(name));
    if (names.length === 0) return;
    const reader = new TarReader(MAX_FILE_BYTES);
    const list = Buffer.from(names.map((name) => `${name}\0`).join(""));
    let code = 1;
    let stderr = "";
    // Kata can stall large stdout while exec also has stdin attached. Stage the
    // NUL-delimited file list separately so the archive exec only reads stdout.
    const listPath = `/tmp/rakazo-workspace-${randomUUID()}`;
    try {
      const staged = await this.collectExec(
        computer,
        ["bash", "-c", 'umask 077; cat > "$1"', "rakazo-export-list", listPath],
        context,
        1024 * 1024,
        Readable.from([list]),
        BULK_TRANSFER_TIMEOUT_MS,
      );
      if (staged.code !== 0)
        throw new Error(staged.stderr.toString("utf8") || "could not stage workspace file list");
      for await (const event of this.execRaw(
        computer,
        withTimeout(
          [
            "tar",
            "--format=pax",
            "--hard-dereference",
            "-c",
            "-C",
            WORKSPACE,
            "--null",
            "--no-recursion",
            "-T",
            listPath,
            "-f",
            "-",
          ],
          BULK_TRANSFER_TIMEOUT_MS,
        ),
        context.signal,
        BULK_TRANSFER_TIMEOUT_MS,
      )) {
        if (event.type === "exit") code = event.code;
        else if (event.type === "stderr") stderr += event.data.toString("utf8");
        else {
          for (const file of reader.push(event.data)) {
            context.signal.throwIfAborted();
            yield file;
          }
        }
      }
    } finally {
      await this.run(
        computer,
        ["rm", "-f", "--", listPath],
        {
          ...context,
          signal: AbortSignal.timeout(10_000),
        },
        10_000,
      );
    }
    if (code !== 0) throw new Error(stderr || "could not export computer workspace");
    reader.finish();
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    await this.desktops.stopBrowsers(computer, context);
    // One exec extracts a tar stream; see exportWorkspace.
    const signal = context.signal;
    async function* archive(): AsyncIterable<Buffer> {
      for await (const file of files) {
        if (shouldSkipPortableWorkspaceFile(file.path)) continue;
        signal.throwIfAborted();
        workspacePath(WORKSPACE, file.path);
        yield* encodeTarEntry(normalizeWorkspacePath(file.path), file.content, file.executable);
      }
      yield TAR_END;
    }
    const result = await this.collectExec(
      computer,
      ["tar", "-x", "-C", WORKSPACE, "--no-same-owner", "-f", "-"],
      context,
      1024 * 1024,
      Readable.from(archive()),
      BULK_TRANSFER_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      throw new Error(result.stderr.toString("utf8") || "could not import computer workspace");
    }
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    const observation = await this.observe(computer, context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
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
    signal.throwIfAborted();
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      const request = Promise.all([loadKubernetes(), this.clients()]).then(
        ([{ Observable }, clients]) =>
          clients.core.readNamespacedPod(
            { name, namespace: this.namespace },
            {
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
            },
          ),
      );
      const pod = await abortableRequest(request, requestSignal);
      signal.throwIfAborted();
      return pod;
    } catch (error) {
      if (isApiStatus(error, 404)) return undefined;
      throw error;
    }
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

  private async deletePod(name: string): Promise<void> {
    try {
      await (await this.clients()).core.deleteNamespacedPod({
        name,
        namespace: this.namespace,
        gracePeriodSeconds: 0,
        propagationPolicy: "Background",
      });
    } catch (error) {
      if (!isApiStatus(error, 404)) throw error;
    }
  }

  private async run(
    computer: ComputerRef,
    command: string[],
    context: AdapterContext,
    timeoutMs = boundedSandboxCommandTimeoutMs(undefined),
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const result = await this.collectExec(
      computer,
      command,
      context,
      MAX_FILE_BYTES,
      undefined,
      timeoutMs,
    );
    return {
      code: result.code,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    };
  }

  private async collectExec(
    computer: ComputerRef,
    command: string[],
    context: AdapterContext,
    maxOutputBytes: number,
    stdin?: Readable,
    timeoutMs = boundedSandboxCommandTimeoutMs(undefined),
  ): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let code = 1;
    for await (const event of this.execRaw(
      computer,
      withTimeout(command, timeoutMs),
      context.signal,
      timeoutMs,
      stdin,
    )) {
      if (event.type === "exit") {
        code = event.code;
        continue;
      }
      outputBytes += event.data.byteLength;
      if (outputBytes > maxOutputBytes) throw new Error("Kubernetes command output is too large");
      (event.type === "stdout" ? stdout : stderr).push(event.data);
    }
    return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  }

  private async *execRaw(
    computer: ComputerRef,
    command: string[],
    signal: AbortSignal,
    timeoutMs: number,
    stdin?: Readable,
    tty = false,
  ): AsyncIterable<RawExecEvent> {
    const queue: RawExecEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let failure: unknown;
    let socket: Awaited<ReturnType<KubernetesSandboxSdk["exec"]["exec"]>> | undefined;
    let settled!: () => void;
    const completed = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const push = (event: RawExecEvent) => {
      if (done) return;
      queue.push(event);
      wake?.();
      wake = undefined;
    };
    const finish = (code: number) => {
      if (done) return;
      queue.push({ type: "exit", code });
      done = true;
      settled();
      wake?.();
      wake = undefined;
    };
    const fail = (error: unknown) => {
      if (done) return;
      failure = error;
      done = true;
      settled();
      wake?.();
      wake = undefined;
    };
    const stdout = new PassThrough();
    const stderr = tty ? undefined : new PassThrough();
    stdout.on("data", (data: Buffer) => push({ type: "stdout", data: Buffer.from(data) }));
    stderr?.on("data", (data: Buffer) => push({ type: "stderr", data: Buffer.from(data) }));
    const abort = () => {
      socket?.close();
      push({ type: "stderr", data: Buffer.from("command aborted\n") });
      finish(130);
    };
    const timeout = setTimeout(() => {
      socket?.close();
      push({
        type: "stderr",
        data: Buffer.from(`command timed out after ${timeoutMs} ms\n`),
      });
      finish(124);
    }, timeoutMs + 10_000);
    signal.addEventListener("abort", abort, { once: true });
    // A failing input stream (for example a workspace iterator that throws)
    // would otherwise leave the exec waiting for input until the timeout.
    stdin?.on("error", fail);
    try {
      if (signal.aborted) {
        abort();
      } else {
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
            (status) => finish(exitCode(status)),
          ),
        );
        await Promise.race([
          connecting.then((connected) => {
            socket = connected;
            if (done) {
              connected.close();
              return;
            }
            connected.onclose = () => finish(1);
            connected.onerror = (event) => fail(event.error ?? new Error("Kubernetes exec failed"));
          }, fail),
          completed,
        ]);
      }
      while (!done || queue.length) {
        if (!queue.length) await new Promise<void>((resolve) => (wake = resolve));
        while (queue.length) yield queue.shift()!;
      }
      if (failure) throw failure;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      socket?.close();
      stdin?.destroy();
      stdout.destroy();
      stderr?.destroy();
    }
  }
}

let kubernetesModule: Promise<typeof KubernetesClient> | undefined;

/** Deferred so deployments that never select this provider do not load the SDK at boot. */
function loadKubernetes(): Promise<typeof KubernetesClient> {
  kubernetesModule ??= import("@kubernetes/client-node");
  return kubernetesModule;
}

function commandRequestArgv(request: CommandRequest, timeoutMs: number): string[] {
  const cwd = kubernetesCwd(request.cwd);
  const environment = Object.entries({ ...COMPUTER_CACHE_ENV, ...request.env }).map(
    ([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new Error(`invalid environment name ${name}`);
      return `${name}=${value}`;
    },
  );
  return [
    "bash",
    "-c",
    'cd -- "$1" && shift && exec env "$@"',
    "rakazo-exec",
    cwd,
    ...environment,
    ...withTimeout(sandboxCommandArgv(request), timeoutMs),
  ];
}

function withTimeout(command: string[], timeoutMs: number): string[] {
  return [
    "timeout",
    "--signal=TERM",
    "--kill-after=5s",
    `${Math.max(1, Math.ceil(timeoutMs / 1_000))}s`,
    ...command,
  ];
}

function kubernetesCwd(cwd: string | undefined): string {
  if (!cwd || cwd === "." || cwd === "/" || cwd === WORKSPACE) return WORKSPACE;
  return workspacePath(
    WORKSPACE,
    cwd.startsWith(`${WORKSPACE}/`) ? cwd.slice(WORKSPACE.length + 1) : cwd,
  );
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
  const error = new Error(`Kubernetes computer ${name} no longer exists`, { cause });
  error.name = "SandboxNotFoundError";
  return error;
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

const TAR_BLOCK = 512;
const TAR_END = Buffer.alloc(TAR_BLOCK * 2);

function tarHeader(name: string, type: string, size: number, mode: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK);
  header.write(name, 0, 100, "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(0x20, 148, 156);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
}

function* tarBody(content: Uint8Array): Iterable<Buffer> {
  if (content.byteLength > 0)
    yield Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  const padding = (TAR_BLOCK - (content.byteLength % TAR_BLOCK)) % TAR_BLOCK;
  if (padding) yield Buffer.alloc(padding);
}

/** One regular file as ustar blocks, with a PAX path record when the name does not fit. */
export function* encodeTarEntry(
  name: string,
  content: Uint8Array,
  executable?: boolean,
): Iterable<Buffer> {
  if (Buffer.byteLength(name) > 100 || /[^\x20-\x7e]/.test(name)) {
    const body = paxRecord("path", name);
    yield tarHeader("PaxHeader", "x", body.byteLength, 0o644);
    yield* tarBody(body);
  }
  yield tarHeader(name, "0", content.byteLength, executable ? 0o700 : 0o600);
  yield* tarBody(content);
}

function paxRecord(key: string, value: string): Buffer {
  const rest = Buffer.from(` ${key}=${value}\n`);
  let length = rest.byteLength + 1;
  while (String(length).length + rest.byteLength !== length) {
    length = String(length).length + rest.byteLength;
  }
  return Buffer.concat([Buffer.from(String(length)), rest]);
}

/** Incremental reader for the regular files in a ustar/PAX stream. */
export class TarReader {
  private buffer: Buffer = Buffer.alloc(0);
  private pending:
    | { name: string; mode: number; size: number; kind: "file" | "pax" | "skip" }
    | undefined;
  private paxPath: string | undefined;
  private ended = false;

  constructor(private readonly maxFileBytes: number) {}

  push(chunk: Buffer): PortableFile[] {
    this.buffer = this.buffer.byteLength ? Buffer.concat([this.buffer, chunk]) : chunk;
    const files: PortableFile[] = [];
    while (!this.ended) {
      if (!this.pending) {
        if (this.buffer.byteLength < TAR_BLOCK) break;
        const header = this.buffer.subarray(0, TAR_BLOCK);
        this.buffer = this.buffer.subarray(TAR_BLOCK);
        if (header.every((byte) => byte === 0)) {
          this.ended = true;
          break;
        }
        this.pending = this.parseHeader(header);
      }
      const { size } = this.pending;
      const padded = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
      if (this.buffer.byteLength < padded) break;
      const body = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(padded);
      const { kind, name, mode } = this.pending;
      this.pending = undefined;
      if (kind === "pax") this.paxPath = parsePaxPath(body) ?? this.paxPath;
      else if (kind === "file") {
        files.push({
          path: normalizeWorkspacePath(name),
          content: new Uint8Array(Buffer.from(body)),
          ...((mode & 0o111) !== 0 ? { executable: true } : {}),
        });
      }
    }
    return files;
  }

  finish(): void {
    if (this.pending) throw new Error("workspace archive ended inside a file");
  }

  private parseHeader(header: Buffer) {
    const field = (start: number, length: number) =>
      header.toString("utf8", start, start + length).replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const mode = Number.parseInt(field(100, 8).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid workspace archive");
    const type = field(156, 1) || "0";
    const prefix = field(345, 155);
    const base = field(0, 100);
    const name = this.paxPath ?? (prefix ? `${prefix}/${base}` : base);
    if (type === "x") return { name, mode, size, kind: "pax" as const };
    if (type !== "0") return { name, mode, size, kind: "skip" as const };
    this.paxPath = undefined;
    if (size > this.maxFileBytes)
      throw new Error(`computer file exceeds ${this.maxFileBytes} bytes`);
    return { name, mode, size, kind: "file" as const };
  }
}

function parsePaxPath(body: Buffer): string | undefined {
  let offset = 0;
  while (offset < body.byteLength) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) return undefined;
    const length = Number(body.toString("utf8", offset, space));
    if (!Number.isSafeInteger(length) || length <= 0) return undefined;
    const record = body.toString("utf8", space + 1, offset + length - 1);
    if (record.startsWith("path=")) return record.slice(5);
    offset += length;
  }
  return undefined;
}
