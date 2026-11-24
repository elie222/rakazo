import type {
  AdapterContext,
  BrowserActRequest,
  BrowserActResult,
  BrowserNavigateRequest,
  BrowserNavigateResult,
  BrowserProvider,
  BrowserPurchaseCheckRequest,
  BrowserPurchaseCheckResult,
  BrowserPurchaseItem,
  BrowserSnapshotNode,
  BrowserSnapshotRequest,
  BrowserSnapshotResult,
  ComputerRef,
  PageBrowserCommand,
  PageBrowserResult,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { SandboxRequestRejectedError } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { FakeBrowserProviderOptions } from "../../browser/fake-browser.js";
import { FakeBrowserProvider } from "../../browser/fake-browser.js";
import { PAGE_BROWSER_TIMED_OUT } from "./computer-screens.js";
import { logPageBrowserFailure } from "./page-browser-failure.js";

const DETACHED_MESSAGE = "Page browser is not attached to this computer's Chrome.";
/** What a routed sandbox answers when the computer's provider has no page browser. */
const UNAVAILABLE_MESSAGE = "Page browser is unavailable on this computer.";
/** What the helper reports, in place of a purchase, when it could not read the page at all. */
const UNREADABLE_REASON = "unreadable";

const isPurchaseItem = (item: unknown): item is BrowserPurchaseItem =>
  typeof (item as BrowserPurchaseItem | null)?.name === "string" &&
  typeof (item as BrowserPurchaseItem).amount === "string";

/**
 * Whether a failed purchase check means this computer cannot check at all, rather than that the check
 * failed: a page browser from before the check ("unknown command"), none at all (detached, or a computer
 * whose provider has none), or a supervisor from before it. Every other failure refuses the press, a 500
 * included: only an unhandled error answers that.
 */
function cannotCheck(error: unknown): boolean {
  return (
    typeof error === "string" &&
    (error === "unknown command: purchase_check" ||
      error === DETACHED_MESSAGE ||
      error === UNAVAILABLE_MESSAGE ||
      // An older supervisor rejects the unknown command's body before running anything.
      /^page browser failed: (400|404|422)$/.test(error))
  );
}

type LivePayload = Partial<PageBrowserResult>;

export type LivePageBrowserDriver = (
  computer: ComputerRef,
  request: PageBrowserCommand,
  context: AdapterContext,
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
        page: Boolean(
          this.liveDriver || this.sandbox?.pageBrowser || this.sandbox?.describe().id === "fake",
        ),
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
    const live = await this.runLive(
      computer,
      { command: "navigate", url: request.url, downloads: request.downloads },
      context,
    );
    if (live?.ok !== true || live.fallback === "computer_act") {
      return {
        url: request.url,
        title: "",
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
        ...pageNotice(live),
      };
    }
    // The page comes with the navigation when the helper could read it in time.
    const page =
      typeof live.tree === "string" && Array.isArray(live.elements)
        ? { tree: live.tree, elements: live.elements }
        : {};
    return {
      url: typeof live.url === "string" ? live.url : request.url,
      title: typeof live.title === "string" ? live.title : "",
      ...page,
      ...(page.tree !== undefined && live.loading === true ? { loading: true } : {}),
      ...downloadsOf(live),
      ...pageNotice(live),
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
    const live = await this.runLive(
      computer,
      {
        command: "snapshot",
        ...(request.query ? { query: request.query } : {}),
        downloads: request.downloads,
      },
      context,
    );
    if (live?.ok !== true || live.fallback === "computer_act") {
      return {
        url: "",
        title: "",
        tree: "",
        elements: [],
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
        ...downloadsOf(live),
        ...pageNotice(live),
      };
    }
    const elements = Array.isArray(live.elements) ? live.elements : [];
    return {
      url: typeof live.url === "string" ? live.url : "",
      title: typeof live.title === "string" ? live.title : "",
      tree: typeof live.tree === "string" ? live.tree : formatTree(elements),
      elements,
      ...(live.loading === true ? { loading: true } : {}),
      ...downloadsOf(live),
      ...pageNotice(live),
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
    const live = await this.runLive(
      computer,
      { command: "act", actions: request.actions, downloads: request.downloads },
      context,
    );
    const elements = Array.isArray(live?.elements) ? live.elements : undefined;
    // The helper refused a step before changing the page: settled, and fixable without desktop tools.
    if (live?.ok === false && live.uncertain === false && live.fallback === undefined) {
      // A page snapshot sent with the refusal is kept, so the bot can pick the right field.
      const tree =
        typeof live.tree === "string" ? live.tree : elements ? formatTree(elements) : undefined;
      return {
        ok: false,
        completed: typeof live.completed === "number" ? live.completed : 0,
        uncertain: false,
        url: typeof live.url === "string" ? live.url : "",
        title: typeof live.title === "string" ? live.title : "",
        ...(tree !== undefined ? { tree, elements } : {}),
        ...downloadsOf(live),
        error: live.error || DETACHED_MESSAGE,
      };
    }
    if (live?.ok !== true || live.fallback === "computer_act") {
      return {
        ok: false,
        completed: typeof live?.completed === "number" ? live.completed : 0,
        uncertain: live?.uncertain ?? true,
        url: typeof live?.url === "string" ? live.url : "",
        title: typeof live?.title === "string" ? live.title : "",
        // A step that stopped partway, such as typing, still shows the page as it was left.
        ...(elements
          ? { tree: typeof live?.tree === "string" ? live.tree : formatTree(elements), elements }
          : {}),
        ...downloadsOf(live),
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
        ...pageNotice(live),
      };
    }
    return {
      ok: true,
      completed: typeof live.completed === "number" ? live.completed : request.actions.length,
      url: typeof live.url === "string" ? live.url : "",
      title: typeof live.title === "string" ? live.title : "",
      tree: typeof live.tree === "string" ? live.tree : elements ? formatTree(elements) : undefined,
      elements,
      ...(live.loading === true ? { loading: true } : {}),
      ...downloadsOf(live),
      ...pageNotice(live),
    };
  }

  /**
   * Whether these clicks, or a click or key on the screen, would complete a purchase. A computer
   * image from before the check answers "unknown command": it cannot tell, so nothing is asked.
   * A check that started and could not read the page throws, and the press is refused, unless the
   * helper found a JavaScript dialog open on it, which is reported for the caller to judge.
   */
  async purchaseCheck(
    computer: ComputerRef,
    request: BrowserPurchaseCheckRequest,
    context: AdapterContext,
  ): Promise<BrowserPurchaseCheckResult> {
    if (this.canUseInProcess(computer)) return { purchase: null };
    const probe: PageBrowserCommand = {
      command: "purchase_check",
      actions: request.actions,
      desktop: request.desktop,
      enter: request.enter,
      points: request.points,
      unplaced: request.unplaced,
    };
    let live = await this.runLive(computer, probe, context);
    // A busy page often answers the next probe; the probe presses nothing, so one retry is safe.
    if (live?.ok !== true && live?.error?.startsWith(`${PAGE_BROWSER_TIMED_OUT};`))
      live = await this.runLive(computer, probe, context);
    if (live?.ok !== true) {
      // The check started and failed (timed out, killed, a page it could not read).
      if (!cannotCheck(live?.error)) unreadable(live?.error);
      if (!this.purchaseCheckWarned) {
        this.purchaseCheckWarned = true;
        getLogger().warn("purchase check unavailable on a computer", { error: live?.error });
      }
      return { purchase: null };
    }
    // A JavaScript dialog open on the page: the page takes no input until it closes, so a press reaches
    // only the dialog. Whether it may answer it is decided with the rest of the call (detectPurchase).
    if (typeof live.dialog === "string" && live.dialog)
      return { purchase: null, dialog: live.dialog };
    const found = live.purchase as
      | {
          steps?: unknown;
          label?: unknown;
          amount?: unknown;
          amountFrom?: unknown;
          reason?: unknown;
          total?: unknown;
          items?: unknown;
        }
      | null
      | undefined;
    if (!found) return { purchase: null };
    // A check that ran but could not read even the page's own signals: nothing was checked.
    if (found.reason === UNREADABLE_REASON) unreadable(UNREADABLE_REASON);
    return {
      purchase: {
        steps: Array.isArray(found.steps)
          ? found.steps.filter((step): step is number => Number.isInteger(step))
          : [],
        // A page without a host (about:blank, data:, file:) still asks, naming no site.
        site: typeof live.site === "string" ? live.site : "",
        label: typeof found.label === "string" ? found.label : "",
        amount: typeof found.amount === "string" ? found.amount : "",
        amountSource: found.amountFrom === "button" ? "button" : "page",
        ...(typeof found.total === "string" && found.total ? { total: found.total } : {}),
        ...(Array.isArray(found.items) ? { items: found.items.filter(isPurchaseItem) } : {}),
      },
    };
  }

  private purchaseCheckWarned = false;

  private canUseInProcess(computer: ComputerRef): boolean {
    return computer.kind === "fake";
  }

  private async runLive(
    computer: ComputerRef,
    request: PageBrowserCommand,
    context: AdapterContext,
  ): Promise<LivePayload> {
    context.signal.throwIfAborted();
    try {
      const result = this.liveDriver
        ? await this.liveDriver(computer, request, context)
        : this.sandbox?.pageBrowser
          ? await this.sandbox.pageBrowser(computer, request, context)
          : {
              ok: false,
              error: DETACHED_MESSAGE,
              fallback: "computer_act" as const,
              uncertain: false,
            };
      if (result?.ok === true) {
        if (typeof result.url !== "string" || typeof result.title !== "string") {
          throw new Error("Incomplete page browser response");
        }
        if (
          request.command === "snapshot" &&
          (typeof result.tree !== "string" || !Array.isArray(result.elements))
        ) {
          throw new Error("Incomplete page snapshot");
        }
        if (
          request.command === "act" &&
          (!Number.isInteger(result.completed) ||
            result.completed !== request.actions.length ||
            result.uncertain)
        ) {
          throw new Error("Unconfirmed page actions");
        }
      }
      if (result?.ok === false) logPageBrowserFailure(computer, request, context, result);
      return result;
    } catch (error) {
      context.signal.throwIfAborted();
      // The request was refused before it reached the page: settled, nothing was done.
      const failed =
        error instanceof SandboxRequestRejectedError
          ? { ok: false as const, uncertain: false, error: error.message }
          : {
              uncertain: request.command === "act",
              ok: false as const,
              error: error instanceof Error ? error.message : String(error),
              fallback: "computer_act" as const,
            };
      logPageBrowserFailure(computer, request, context, failed);
      return failed;
    }
  }
}

/** A purchase check that could not read the page: the press is refused. */
function unreadable(error: unknown): never {
  getLogger().warn("purchase check failed", { error });
  throw new Error("The purchase check could not read the page.");
}

/** Files the call's page downloaded, which the helper lists even when a later step failed. */
function downloadsOf(live: LivePayload | undefined) {
  return Array.isArray(live?.downloads) ? { downloads: live.downloads } : {};
}

/** What the helper reports about the page beyond its contents: a closed alert, or a dialog still open. */
function pageNotice(live: LivePayload | undefined): { note?: string; dialog?: string } {
  return {
    ...(typeof live?.note === "string" ? { note: live.note } : {}),
    ...(typeof live?.dialog === "string" ? { dialog: live.dialog } : {}),
  };
}

function formatTree(elements: BrowserSnapshotNode[]): string {
  if (elements.length === 0) return "(no interactive elements)";
  return elements
    .map((el) => {
      const value =
        el.value !== undefined && el.value !== "" ? ` value=${JSON.stringify(el.value)}` : "";
      return `- ${el.role} ${JSON.stringify(el.name)} [${el.ref}]${value}`;
    })
    .join("\n");
}
