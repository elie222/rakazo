import type {
  ComputerStatus,
  ProductEvent,
  RunStatus,
  ThreadMessagePage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { activeThreadRuns, isActive, prependThreadHistoryPage } from "@rakazo/core";

const computerStates: ReadonlySet<unknown> = new Set<ComputerStatus["state"]>([
  "stopped",
  "booting",
  "running",
  "suspended",
  "error",
]);

/** Reason the newest run stopped, until the reader dismisses that run's failure. */
export function threadRunError(
  snapshot: ThreadSnapshot | null,
  dismissedRunIds?: ReadonlySet<string>,
): string | null {
  const run = snapshot?.run;
  if (run?.status !== "failed" || dismissedRunIds?.has(run.id)) return null;
  return run.error ?? null;
}

export function clearActiveThreadRuns(snapshot: ThreadSnapshot): ThreadSnapshot {
  const runIds = new Set(activeThreadRuns(snapshot).map((run) => run.id));
  const computer = snapshot.computer?.busyBotName
    ? { ...snapshot.computer, busyBotName: null }
    : snapshot.computer;
  return {
    ...snapshot,
    run: null,
    activeRuns: [],
    messages: snapshot.messages.filter(
      (message) =>
        !message.runId || !runIds.has(message.runId) || !message.id.startsWith("progress:"),
    ),
    computer,
  };
}

export function prependThreadMessagePage(
  prev: ThreadSnapshot | null,
  page: ThreadMessagePage,
): ThreadSnapshot | null {
  return prependThreadHistoryPage(prev, page);
}

export function userHoldsComputerControl(
  computer:
    | Pick<ComputerStatus, "controlHolder" | "controlBotId" | "controlledByOther">
    | null
    | undefined,
  botId: string | undefined,
): boolean {
  return Boolean(
    botId &&
      computer?.controlHolder === "user" &&
      computer.controlBotId === botId &&
      !computer.controlledByOther,
  );
}

/** True when a live bot run is blocking Take control (API would return 409). */
export function computerTakeoverBlocked(
  computer: Pick<ComputerStatus, "busyBotName"> | null | undefined,
  runStatus?: string | null,
): boolean {
  if (!computer?.busyBotName) return false;
  // waiting_takeover is the bot asking for control; terminal/idle clears the block even if
  // busyBotName is briefly stale while the executor still holds the lease in finally.
  if (!runStatus || runStatus === "waiting_takeover") return false;
  return isActive(runStatus as RunStatus);
}

/**
 * The panel only reconnects a computer that is already running; starting a stopped one waits
 * for the user to open it, so showing the panel or switching bots never boots a sandbox.
 * Reconnect must use computer.boot — never computer.recover (that destroys the sandbox).
 */
export function computerPanelNeedsScreen(
  state: ComputerStatus["state"] | undefined,
  screenUrl?: string | null,
): boolean {
  return state === "running" && !screenUrl;
}

export function reduceComputerStatus(
  prev: ComputerStatus | null,
  event: ProductEvent,
): ComputerStatus | null {
  if (!prev) return prev;
  if (!isComputerStatusEvent(event)) return prev;
  if (event.botId !== prev.botId) return prev;
  if (event.type === "computer.takeover.requested") {
    const retainedControl = event.payload.retainedControl === true;
    const next = {
      ...prev,
      busyBotName: null,
      takeoverRequested: true,
      ...(retainedControl ? {} : { controlHolder: "none" as const, controlBotId: null }),
    };
    return prev.busyBotName === next.busyBotName &&
      prev.takeoverRequested === next.takeoverRequested &&
      prev.controlHolder === next.controlHolder &&
      prev.controlBotId === next.controlBotId
      ? prev
      : next;
  }
  if (event.type === "computer.takeover.granted") {
    const takeoverRequested = event.payload.takeoverRequested === true;
    return prev.controlHolder === "user" &&
      prev.controlBotId === event.botId &&
      prev.takeoverRequested === takeoverRequested &&
      prev.busyBotName === null
      ? prev
      : {
          ...prev,
          controlHolder: "user",
          controlBotId: event.botId,
          takeoverRequested,
          busyBotName: null,
        };
  }
  if (event.type === "computer.takeover.released") {
    const holder = event.payload.holder;
    if (holder !== "bot" && holder !== "none") return prev;
    return prev.controlHolder === holder &&
      prev.controlBotId === null &&
      !prev.takeoverRequested &&
      prev.busyBotName === null &&
      !prev.controlledByOther
      ? prev
      : {
          ...prev,
          controlHolder: holder,
          controlBotId: null,
          takeoverRequested: false,
          busyBotName: null,
          controlledByOther: undefined,
        };
  }
  const status = event.payload.status;
  if (!isComputerState(status)) return prev;
  const screenAvailable = status === "running" || status === "booting" || prev.screenAvailable;
  if (status === prev.state && screenAvailable === prev.screenAvailable) return prev;
  return {
    ...prev,
    state: status,
    screenAvailable,
  };
}

export function isComputerStatusEvent(event: ProductEvent): boolean {
  return (
    event.type === "computer.status" ||
    event.type === "computer.takeover.requested" ||
    event.type === "computer.takeover.granted" ||
    event.type === "computer.takeover.released"
  );
}

function isComputerState(value: unknown): value is ComputerStatus["state"] {
  return computerStates.has(value);
}

export function screenMissing(options: {
  state: ComputerStatus["state"] | undefined;
  kind: ComputerStatus["kind"] | undefined;
  booting: boolean;
  screenUrlLoaded: boolean;
  embeddedUrl: string | null;
}): boolean {
  return (
    options.state === "running" &&
    options.kind !== "desktop" &&
    !options.booting &&
    options.screenUrlLoaded &&
    !options.embeddedUrl
  );
}

export function screenReadLoaded(
  issued: ComputerStatus["state"] | undefined,
  current: ComputerStatus["state"] | undefined,
): boolean {
  return issued === "running" && current === "running";
}
