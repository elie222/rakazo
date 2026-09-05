import type {
  AdapterContext,
  BrowserActRequest,
  BrowserActResult,
  BrowserNavigateRequest,
  BrowserNavigateResult,
  BrowserProvider,
  BrowserSnapshotNode,
  BrowserSnapshotRequest,
  BrowserSnapshotResult,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { sandboxCommandTimeoutMs } from "@rakazo/core";
import { FakeBrowserProvider, type FakeBrowserProviderOptions } from "./fake-browser.js";
import { pageBrowserSessionKey } from "./page-browser-session.js";

const DETACHED_MESSAGE =
  "Page browser is not attached to this computer's Chrome. Use computer_act on the desktop browser instead.";

const LIVE_HELPER = "/usr/local/bin/rakazo-page-browser";

type LivePayload = {
  ok?: boolean;
  url?: string;
  title?: string;
  tree?: string;
  elements?: BrowserSnapshotNode[];
  completed?: number;
  error?: string;
  fallback?: "computer_act";
};

export type LivePageBrowserDriver = (
  computer: ComputerRef,
  context: AdapterContext,
  command: "navigate" | "snapshot" | "act",
  args: Record<string, unknown>,
) => Promise<LivePayload>;

/**
 * Production page-browser adapter for the bot computer.
 *
 * Fake computers (and the fake sandbox) use the in-process DOM session.
 * Real computers drive the live Chrome already on the graphical display via
 * CDP (`rakazo-page-browser`). If that path cannot operate, return
 * `fallback: "computer_act"` — never report success against a detached DOM.
 */
export class ComputerBrowserProvider implements BrowserProvider {
  private readonly fake: FakeBrowserProvider;
  private readonly sandbox?: SandboxProvider;
  private readonly liveDriver?: LivePageBrowserDriver;

  constructor(
    options: FakeBrowserProviderOptions & {
      sandbox?: SandboxProvider;
      /** Test seam for the live CDP helper. */
      liveDriver?: LivePageBrowserDriver;
    } = {},
  ) {
    const { sandbox, liveDriver, ...fakeOptions } = options;
    this.sandbox = sandbox;
    this.liveDriver = liveDriver;
    this.fake = new FakeBrowserProvider(fakeOptions);
  }

  describe() {
    return {
      id: "computer",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        page: true,
        refs: true,
        keyless: true,
      },
    };
  }

  async navigate(
    computer: ComputerRef,
    request: BrowserNavigateRequest,
    context: AdapterContext,
  ): Promise<BrowserNavigateResult> {
    if (this.canUseInProcess(computer)) {
      return this.fake.navigate(computer, request, context);
    }
    const live = await this.runLive(computer, context, "navigate", { url: request.url });
    if (!live || live.ok === false || live.fallback === "computer_act") {
      return {
        url: request.url,
        title: "",
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
      };
    }
    return {
      url: typeof live.url === "string" ? live.url : request.url,
      title: typeof live.title === "string" ? live.title : "",
    };
  }

  async snapshot(
    computer: ComputerRef,
    request: BrowserSnapshotRequest,
    context: AdapterContext,
  ): Promise<BrowserSnapshotResult> {
    if (this.canUseInProcess(computer)) {
      return this.fake.snapshot(computer, request, context);
    }
    const live = await this.runLive(computer, context, "snapshot", {});
    if (!live || live.ok === false || live.fallback === "computer_act") {
      return {
        url: "",
        title: "",
        tree: "",
        elements: [],
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
      };
    }
    const elements = Array.isArray(live.elements) ? live.elements : [];
    return {
      url: typeof live.url === "string" ? live.url : "",
      title: typeof live.title === "string" ? live.title : "",
      tree: typeof live.tree === "string" ? live.tree : formatTree(elements),
      elements,
    };
  }

  async act(
    computer: ComputerRef,
    request: BrowserActRequest,
    context: AdapterContext,
  ): Promise<BrowserActResult> {
    if (this.canUseInProcess(computer)) {
      return this.fake.act(computer, request, context);
    }
    const live = await this.runLive(computer, context, "act", {
      actions: request.actions.map((step) =>
        step.kind === "click"
          ? { kind: step.kind, ref: step.ref }
          : { kind: step.kind, ref: step.ref, text: step.text },
      ),
    });
    if (!live || live.ok === false || live.fallback === "computer_act") {
      return {
        ok: false,
        completed: typeof live?.completed === "number" ? live.completed : 0,
        url: typeof live?.url === "string" ? live.url : "",
        title: typeof live?.title === "string" ? live.title : "",
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
      };
    }
    const elements = Array.isArray(live.elements) ? live.elements : undefined;
    return {
      ok: true,
      completed: typeof live.completed === "number" ? live.completed : request.actions.length,
      url: typeof live.url === "string" ? live.url : "",
      title: typeof live.title === "string" ? live.title : "",
      tree: typeof live.tree === "string" ? live.tree : elements ? formatTree(elements) : undefined,
      elements,
    };
  }

  private canUseInProcess(computer: ComputerRef): boolean {
    if (computer.kind === "fake") return true;
    const id = this.sandbox?.describe().id;
    return id === "fake";
  }

  private async runLive(
    computer: ComputerRef,
    context: AdapterContext,
    command: "navigate" | "snapshot" | "act",
    args: Record<string, unknown>,
  ): Promise<LivePayload | null> {
    const driver = this.liveDriver ?? (this.sandbox ? sandboxLiveDriver(this.sandbox) : null);
    if (!driver) return { ok: false, error: DETACHED_MESSAGE, fallback: "computer_act" };
    try {
      return await driver(computer, context, command, {
        ...args,
        sessionKey: pageBrowserSessionKey(computer, context),
      });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        fallback: "computer_act",
      };
    }
  }
}

function sandboxLiveDriver(sandbox: SandboxProvider): LivePageBrowserDriver {
  return async (computer, context, command, args) => {
    const payload = JSON.stringify(args);
    let stdout = "";
    let stderr = "";
    let code = 1;
    for await (const event of sandbox.execute(
      computer,
      {
        argv: [LIVE_HELPER, command, payload],
        timeoutMs: Math.min(sandboxCommandTimeoutMs(), 60_000),
      },
      context,
    )) {
      if (event.type === "stdout") stdout += event.data;
      if (event.type === "stderr") stderr += event.data;
      if (event.type === "exit") code = event.code;
    }
    const parsed = parseLiveStdout(stdout);
    if (parsed) return parsed;
    return {
      ok: false,
      fallback: "computer_act",
      error:
        stderr.trim() ||
        (code === 0 ? "live page browser returned no JSON" : `live page browser exited ${code}`),
    };
  };
}

function parseLiveStdout(stdout: string): LivePayload | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const value = JSON.parse(lines[i]!) as LivePayload;
      if (value && typeof value === "object") return value;
    } catch {
      // keep scanning for the last JSON object
    }
  }
  return null;
}

function formatTree(elements: BrowserSnapshotNode[]): string {
  if (elements.length === 0) return "(no interactive elements)";
  return elements
    .map((el) => {
      const value =
        el.value !== undefined && el.value !== "" ? ` value=${JSON.stringify(el.value)}` : "";
      return `- ${el.role} "${el.name}" [${el.ref}]${value}`;
    })
    .join("\n");
}
