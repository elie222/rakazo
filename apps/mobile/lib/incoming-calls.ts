import type { IncomingBotCall, SpaceBot, SpaceNavigation } from "@rakazo/contracts";
import type { ringingCall } from "@rakazo/core";
import {
  abortableDelay,
  callIsRinging,
  isRetryableError,
  nextIncomingCall,
  respondToIncomingCall,
  retryDelayMs,
} from "@rakazo/core";
import { requireOptionalNativeModule } from "expo-modules-core";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import type { ApiRequestContext } from "./api";
import {
  captureApiRequestContext,
  loadSessionToken,
  rpc,
  subscribeIncomingCallEvents,
} from "./api";
import { endCall, getSnapshot, startCall, subscribe as subscribeCall } from "./call-session";
import { t } from "./i18n";
import { registerCallPushToken } from "./push";
import { serverHeaders } from "./server-headers";
import { currentSessionGeneration, registerSessionDiskCache } from "./session";

type Ringing = NonNullable<ReturnType<typeof ringingCall>>;
export function usesNativeIncomingCallRingtone() {
  return Platform.OS === "ios" && native !== null;
}
export type { IncomingBotCall } from "@rakazo/contracts";

type NativeAction = { action: "answer" | "end"; callId: string; botId: string; expiresAt: string };
type NativeCalls = {
  configureIncomingSession?(base: string, headers: Record<string, string>): Promise<void>;
  reportIncomingCall(call: Record<string, string>): Promise<void>;
  incomingState(): Promise<{
    token: string;
    actions: NativeAction[];
    ringing?: Array<Omit<NativeAction, "action">>;
  }>;
  finishAnswer(id: string, success: boolean): Promise<void>;
  endIncomingCall(id: string): Promise<void>;
  clearIncomingCalls(): Promise<void>;
  addListener(name: string, callback: () => void): { remove(): void };
};
const module = requireOptionalNativeModule<NativeCalls>("RakazoNotifications");
const native = module?.incomingState ? module : null;
const listeners = new Set<() => void>();
let calls: IncomingBotCall[] = [];
let roster = new Map<string, SpaceBot>();
let feed: AbortController | undefined;
let handled = new Set<string>();
let expiry: ReturnType<typeof setTimeout> | undefined;
let snapshot: IncomingBotCall | null = null;
let running = false;
let responding = false;
let activeNativeCall: string | undefined;
/** Native calls that ended while their answer was still joining. */
let nativeEnded = new Set<string>();

export function subscribeIncomingCalls(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function getIncomingCall() {
  return snapshot;
}
function emit() {
  clearTimeout(expiry);
  snapshot = nextIncomingCall(calls, handled) ?? null;
  for (const listener of listeners) listener();
  if (snapshot)
    expiry = setTimeout(
      emit,
      Math.max(0, Date.parse(snapshot.incomingCall.expiresAt) - Date.now()),
    );
}
function update(
  bot: Pick<SpaceBot, "id" | "spaceId" | "name" | "color" | "avatarSet">,
  call: Ringing | null,
) {
  const previous = calls.find((entry) => entry.id === bot.id);
  calls = calls.filter((entry) => entry.id !== bot.id);
  if (
    previous &&
    previous.incomingCall.callId !== call?.callId &&
    !responding &&
    activeNativeCall !== previous.incomingCall.callId
  )
    void native?.endIncomingCall(previous.incomingCall.callId);
  if (call && callIsRinging(call) && !handled.has(call.callId)) {
    calls.push({ ...bot, incomingCall: call });
    if (Platform.OS === "ios" || AppState.currentState !== "active")
      reportNativeCall({ ...bot, incomingCall: call });
  }
  emit();
}

function reportNativeCall(call: IncomingBotCall) {
  void native?.reportIncomingCall({
    callId: call.incomingCall.callId,
    botId: call.id,
    botName: call.name,
    expiresAt: call.incomingCall.expiresAt,
  });
}

/** Follows the account call stream; every frame is a full snapshot, so reconnects need no replay. */
async function follow(controller: AbortController) {
  const generation = currentSessionGeneration();
  let retry = 250;
  let failure: unknown;
  while (!controller.signal.aborted && generation === currentSessionGeneration()) {
    try {
      await subscribeIncomingCallEvents((incoming) => {
        for (const previous of calls) {
          if (!incoming.some((call) => call.incomingCall.callId === previous.incomingCall.callId))
            update(previous, null);
        }
        for (const call of incoming) update(call, call.incomingCall);
      }, controller.signal);
      retry = 250;
      failure = undefined;
    } catch (error) {
      if (controller.signal.aborted || !isRetryableError(error)) return;
      failure = error;
    }
    await abortableDelay(retryDelayMs(failure, retry), controller.signal).catch(() => undefined);
    retry = Math.min(retry * 2, 5000);
  }
}

function setIncomingCallRoster(navigation: SpaceNavigation) {
  if (!running) return;
  const bots = [...navigation.spaces.flatMap((space) => space.bots), ...navigation.current.bots];
  roster = new Map(bots.map((bot) => [bot.id, bot]));
}
async function loadRoster() {
  const generation = currentSessionGeneration();
  if (!(await loadSessionToken())) return;
  const navigation = await rpc("spaces/list");
  if (running && generation === currentSessionGeneration()) setIncomingCallRoster(navigation);
}

export async function respondToMobileCall(call: IncomingBotCall, action: "answer" | "decline") {
  if (responding) return;
  responding = true;
  const generation = currentSessionGeneration();
  let context: ApiRequestContext | undefined;
  let answered = false;
  try {
    context = await captureApiRequestContext(call.spaceId);
    const target = { botId: call.id, callId: call.incomingCall.callId };
    if (action === "decline")
      await respondToIncomingCall(call.incomingCall, () =>
        rpc(
          "notifications/declineIncomingCall",
          { callId: target.callId },
          { requestContext: context },
        ),
      );
    else {
      const result = await respondToIncomingCall(call.incomingCall, () =>
        rpc("threads/answerCall", target, { requestContext: context }),
      );
      answered = true;
      // A sign-out or server switch mid-answer hangs up below with the answer's own session.
      if (generation !== currentSessionGeneration())
        throw new Error(t("Something went wrong. Try again."));
      const voice = await rpc("voice/status", {}, { requestContext: context });
      if (generation !== currentSessionGeneration())
        throw new Error(t("Something went wrong. Try again."));
      if (nativeEnded.has(target.callId)) throw new Error(t("This call is no longer ringing."));
      // Answering during a call replaces it, like a phone's end-and-accept.
      if (getSnapshot()) endCall();
      activeNativeCall = target.callId;
      startCall({
        botId: call.id,
        botName: call.name,
        botColor: call.color,
        botAvatarSet: call.avatarSet,
        transcribe: voice.transcribe,
        greeting: result.opening,
        answered: { callId: target.callId },
        session: generation,
        requestContext: context,
      });
      await native?.finishAnswer(target.callId, true);
    }
    handled.add(target.callId);
    if (action === "decline") await native?.endIncomingCall(target.callId);
  } catch (error) {
    // Answered elsewhere or rung out: there is nothing left to decline.
    if (action === "decline" && (error as { code?: string } | null)?.code === "CONFLICT") {
      handled.add(call.incomingCall.callId);
      await native?.endIncomingCall(call.incomingCall.callId);
      return;
    }
    if (answered && context) {
      await rpc(
        "threads/endCall",
        { botId: call.id, callId: call.incomingCall.callId },
        { requestContext: context },
      ).catch(() => undefined);
    }
    await native?.finishAnswer(call.incomingCall.callId, false);
    throw error;
  } finally {
    responding = false;
    emit();
  }
}

async function drainNative() {
  const generation = currentSessionGeneration();
  const state = await native?.incomingState();
  // A sign-out during the read belongs to the old session; the new one drains for itself.
  if (!state || !running || generation !== currentSessionGeneration()) return;
  if (state.token) await registerCallPushToken({ voipToken: state.token }).catch(() => undefined);
  for (const ring of state.ringing ?? []) {
    if (!callIsRinging(ring)) continue;
    if (!roster.has(ring.botId)) await loadRoster();
    const bot = roster.get(ring.botId);
    if (bot) update(bot, { ...ring, reason: "", opening: "" });
  }
  for (const action of state.actions) {
    if (action.action === "end") {
      nativeEnded.add(action.callId);
      if (activeNativeCall === action.callId) endCall();
      continue;
    }
    if (!callIsRinging(action)) {
      await native?.finishAnswer(action.callId, false);
      continue;
    }
    if (!roster.has(action.botId)) await loadRoster();
    const bot = roster.get(action.botId);
    if (!bot) {
      await native?.finishAnswer(action.callId, false);
      continue;
    }
    await respondToMobileCall(
      { ...bot, incomingCall: { ...action, reason: "", opening: "" } },
      "answer",
    ).catch(() => undefined);
  }
}

const notificationActions = new Set<string>();
async function notificationResponse(response: Notifications.NotificationResponse | null) {
  if (!response) return;
  const data = response.notification.request.content.data;
  if (
    data?.kind !== "incoming_call" ||
    typeof data.callId !== "string" ||
    typeof data.botId !== "string" ||
    typeof data.expiresAt !== "string" ||
    !callIsRinging({ expiresAt: data.expiresAt })
  )
    return;
  if (response.actionIdentifier !== "answer" && response.actionIdentifier !== "decline") return;
  const key = `${data.callId}:${response.actionIdentifier}`;
  if (notificationActions.has(key)) return;
  notificationActions.add(key);
  try {
    await loadRoster();
    const bot = roster.get(data.botId);
    if (!bot) throw new Error("Unknown caller");
    await respondToMobileCall(
      {
        ...bot,
        incomingCall: { callId: data.callId, expiresAt: data.expiresAt, reason: "", opening: "" },
      },
      response.actionIdentifier,
    );
  } catch (error) {
    notificationActions.delete(key);
    throw error;
  }
}

export function stopIncomingCalls() {
  running = false;
  feed?.abort();
  feed = undefined;
  roster.clear();
  notificationActions.clear();
  calls = [];
  handled = new Set();
  nativeEnded = new Set();
  clearTimeout(expiry);
  snapshot = null;
  activeNativeCall = undefined;
  void native?.clearIncomingCalls();
  for (const listener of listeners) listener();
}
registerSessionDiskCache(stopIncomingCalls);
subscribeCall(() => {
  if (!getSnapshot()) finishMobileNativeCall();
});

export function startIncomingCalls() {
  running = true;
  const controller = new AbortController();
  feed = controller;
  let started = false;
  void Notifications.setNotificationCategoryAsync?.("incoming-call", [
    {
      identifier: "decline",
      buttonTitle: t("Decline"),
      options: { opensAppToForeground: true, isDestructive: true },
    },
    { identifier: "answer", buttonTitle: t("Answer"), options: { opensAppToForeground: true } },
  ]).catch(() => undefined);
  const refresh = () => {
    const generation = currentSessionGeneration();
    void captureApiRequestContext(null)
      .then(async (context) => {
        // SecureStore may still be locked after a cold PushKit launch. Retry on foreground.
        if (
          !context.headers.authorization ||
          !running ||
          feed !== controller ||
          generation !== currentSessionGeneration()
        )
          return;
        await native?.configureIncomingSession?.(context.apiBase, {
          ...serverHeaders(context.apiBase),
          ...context.headers,
        });
        if (!running || feed !== controller || generation !== currentSessionGeneration()) return;
        if (!started) {
          started = true;
          void follow(controller)
            .catch(() => undefined)
            .finally(() => {
              started = false;
            });
        }
        await loadRoster();
        await drainNative();
      })
      .catch(() => undefined);
  };
  refresh();
  void notificationResponse(Notifications.getLastNotificationResponse?.() ?? null).catch(
    () => undefined,
  );
  const response = Notifications.addNotificationResponseReceivedListener?.((response) => {
    void notificationResponse(response).catch(() => undefined);
  });
  const app = AppState.addEventListener("change", (state) => {
    if (state === "active") {
      // Android's in-app screen takes over the ring from the native notification.
      if (Platform.OS === "android")
        for (const call of calls) void native?.endIncomingCall(call.incomingCall.callId);
      refresh();
    } else for (const call of calls) reportNativeCall(call);
  });
  const events = native?.addListener("onIncomingCallChanged", () => {
    void drainNative().catch(() => undefined);
  });
  const push = Notifications.addNotificationReceivedListener(() => refresh());
  return () => {
    app.remove();
    events?.remove();
    push.remove();
    response?.remove();
    stopIncomingCalls();
  };
}

export function finishMobileNativeCall() {
  if (activeNativeCall) void native?.endIncomingCall(activeNativeCall);
  activeNativeCall = undefined;
}
