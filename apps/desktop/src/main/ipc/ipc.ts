import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { desktop, permissionTarget, replacedAppTarget } from "../desktop-state.js";
import { reportDesktopError } from "../system/monitoring.js";
import { fromAppFrame } from "../windows/app-frame.js";
import type {
  IpcArgs,
  IpcChannel,
  IpcChannelName,
  IpcIsSync,
  IpcRefusedAnswer,
  IpcResult,
  IpcWindow,
} from "./ipc-channels.js";
import { ipcChannels, LIVE, REJECTS } from "./ipc-channels.js";

export type IpcCaller = Pick<IpcMainInvokeEvent, "sender" | "senderFrame">;

/** The page is not trusted to send what its bridge is typed to send. */
type Untrusted<Args> = { [Index in keyof Args]: unknown };

export type IpcHandler<Name extends IpcChannelName> = (
  event: IpcCaller,
  ...args: Untrusted<IpcArgs<Name>>
) => IpcIsSync<Name> extends true ? IpcResult<Name> : IpcResult<Name> | Promise<IpcResult<Name>>;

/**
 * Whether a call came from that window's own page: never a subframe or another window, and for
 * an app window never another origin. `handleIpc` asks before every handler; a handler that
 * waits on something asks again before it acts.
 */
export function sentFrom(window: IpcWindow, event: IpcCaller): boolean {
  try {
    if (window !== "setup")
      return (
        fromAppFrame(permissionTarget(), event) ||
        (window === "appOrReplaced" && fromAppFrame(replacedAppTarget(), event))
      );
    const setup = desktop.setupWindow;
    return (
      setup !== null &&
      !setup.isDestroyed() &&
      event.sender === setup.webContents &&
      event.senderFrame !== null &&
      event.senderFrame === event.sender.mainFrame
    );
  } catch {
    // Reading a frame that has gone throws. That caller is refused like any other, and
    // `handleIpc` reports the refusal.
    return false;
  }
}

/**
 * A refusal that says nothing is wrong: the page a server switch is replacing keeps calling
 * until its window goes, and its call would be answered if its window were still the app
 * window. Only that window's own page qualifies, so a subframe, another origin or any other
 * window is still reported.
 */
function expected(window: IpcWindow, event: IpcCaller): boolean {
  return window === "app" && fromAppFrame(replacedAppTarget(), event);
}

/** A page that keeps calling cannot flood the reports, and one early report cannot hide a later caller. */
const REPORT_EVERY_MS = 10 * 60_000;
const reportedAt = new Map<IpcChannelName, number>();

function reportRefusal(channel: IpcChannelName, window: IpcWindow, event: IpcCaller) {
  if (expected(window, event)) return;
  const last = reportedAt.get(channel);
  if (last === undefined || Date.now() - last >= REPORT_EVERY_MS) {
    reportedAt.set(channel, Date.now());
    reportDesktopError(new Error(`Refused IPC call to ${channel}`), "desktop.ipc", {
      "ipc.channel": channel,
    });
  }
}

/**
 * The only way to answer a page. The channel map says which window may call; any other caller
 * is refused before the handler runs, reported unless a server switch explains it, and answered
 * with what the map says a refused caller gets: for a `LIVE` channel, what `whenRefused` reads.
 * Any other rejection is the handler's own failure.
 */
export function handleIpc<Name extends IpcChannelName>(
  channel: Name,
  handler: IpcHandler<Name>,
  ...[whenRefused]: IpcRefusedAnswer<Name>
) {
  const { from, sync, refused }: IpcChannel = ipcChannels[channel];
  const answer = handler as (event: IpcCaller, ...args: unknown[]) => unknown;
  if (sync) {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      if (sentFrom(from, event)) {
        event.returnValue = answer(event, ...args);
      } else {
        reportRefusal(channel, from, event);
        event.returnValue = refused;
      }
    });
    return;
  }
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (sentFrom(from, event)) return answer(event, ...args);
    reportRefusal(channel, from, event);
    if (refused === REJECTS) throw new Error(`This page may not call ${channel}.`);
    return refused === LIVE ? whenRefused?.() : refused;
  });
}
