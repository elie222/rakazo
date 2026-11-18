import { t } from "@lingui/core/macro";
import {
  DESKTOP_MEETING_CALENDAR_DENIED,
  DESKTOP_MEETING_CALENDAR_FAILED,
  DESKTOP_MEETING_CALENDAR_UNAVAILABLE,
} from "@rakazo/contracts";
import { deadlineSignal, withAbort } from "@rakazo/core";
import { desktopBridge } from "../platform/desktop";
import type { RpcClient } from "../query/rpc";

export async function connectMeetingCalendar(rpc: RpcClient, botId: string, signal: AbortSignal) {
  const desktop = desktopBridge();
  if (!desktop) {
    const { authorizationUrl } = await rpc.meetingCalendar.begin({ botId, client: "web" });
    if (!signal.aborted) window.location.assign(authorizationUrl);
    return;
  }

  const oauth = desktop.oauth;
  if (!oauth?.open)
    throw new Error(t`Update Rakazo to connect your calendar from the desktop app.`);
  const value = crypto.getRandomValues(new Uint16Array(1))[0]!;
  const loopbackPort = 49_152 + (value % 16_384);
  const started = await rpc.meetingCalendar.begin({ botId, client: "desktop", loopbackPort });
  signal.throwIfAborted();
  const deadline = deadlineSignal(10 * 60_000, signal);
  let release: (() => void) | undefined;
  const returned = new Promise<string>((resolve) => {
    release = oauth.onCallback(({ code, state }) => {
      if (state === started.state) resolve(code);
    });
  });
  try {
    const [, code] = await Promise.all([
      oauth.open(started.authorizationUrl),
      withAbort(returned, deadline),
    ]);
    if (code === DESKTOP_MEETING_CALENDAR_UNAVAILABLE) {
      throw new Error(t`Calendar sign-in is temporarily unavailable.`);
    }
    if (code === DESKTOP_MEETING_CALENDAR_FAILED) {
      throw new Error(t`Calendar sign-in did not complete.`);
    }
    if (code !== DESKTOP_MEETING_CALENDAR_DENIED && !signal.aborted) {
      await rpc.meetingCalendar.complete({ state: started.state, code });
    }
  } finally {
    release?.();
    if (deadline.aborted) await oauth.cancel?.(started.authorizationUrl);
  }
}
