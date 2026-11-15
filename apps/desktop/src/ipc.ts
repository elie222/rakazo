import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { fromAppFrame } from "./app-frame.js";
import { desktop, permissionTarget } from "./desktop-state.js";
import type {
  IpcArgs,
  IpcChannel,
  IpcChannelName,
  IpcIsSync,
  IpcResult,
  IpcWindow,
} from "./ipc-channels.js";
import { ipcChannels } from "./ipc-channels.js";
import { reportDesktopError } from "./monitoring.js";

export type IpcCaller = Pick<IpcMainInvokeEvent, "sender" | "senderFrame">;

/** The page is not trusted to send what its bridge is typed to send. */
type Untrusted<Args> = { [Index in keyof Args]: unknown };

export type IpcHandler<Name extends IpcChannelName> = (
  event: IpcCaller,
  ...args: Untrusted<IpcArgs<Name>>
) => IpcIsSync<Name> extends true ? IpcResult<Name> : IpcResult<Name> | Promise<IpcResult<Name>>;

/**
 * Whether a call came from that window's own page: never a subframe or another window, and for
 * the app window never another origin. `handleIpc` asks before every handler; a handler that
 * waits on something asks again before it acts.
 */
export function sentFrom(window: IpcWindow, event: IpcCaller): boolean {
  try {
    if (window === "app") return fromAppFrame(permissionTarget(), event);
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

/** A page that keeps calling cannot flood the reports, and one early report cannot hide a later caller. */
const REPORT_EVERY_MS = 10 * 60_000;
const reportedAt = new Map<IpcChannelName, number>();

function refuse(channel: IpcChannelName) {
  const last = reportedAt.get(channel);
  if (last === undefined || Date.now() - last >= REPORT_EVERY_MS) {
    reportedAt.set(channel, Date.now());
    reportDesktopError(new Error(`Refused IPC call to ${channel}`), "desktop.ipc", {
      "ipc.channel": channel,
    });
  }
  return new Error(`This page may not call ${channel}.`);
}

/**
 * The only way to answer a page. The channel map says which window may call; any other caller
 * is refused and reported before the handler runs.
 */
export function handleIpc<Name extends IpcChannelName>(channel: Name, handler: IpcHandler<Name>) {
  const { from, sync }: IpcChannel = ipcChannels[channel];
  const answer = handler as (event: IpcCaller, ...args: unknown[]) => unknown;
  if (sync) {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      // `sendSync` blocks the page until it has an answer, so a refusal answers null.
      if (sentFrom(from, event)) {
        event.returnValue = answer(event, ...args);
      } else {
        refuse(channel);
        event.returnValue = null;
      }
    });
    return;
  }
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!sentFrom(from, event)) throw refuse(channel);
    return answer(event, ...args);
  });
}
