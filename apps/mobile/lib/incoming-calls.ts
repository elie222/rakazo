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
import { captureApiRequestContext, rpc } from "./api";
import { subscribeIncomingCallEvents } from "./api-live";
import { endCall, getSnapshot, startCall, subscribe as subscribeCall } from "./call-session";
import { t } from "./i18n";
import { registerCallPushToken } from "./push";
import { serverHeaders } from "./server-headers";
import { currentSessionGeneration, loadSessionToken, registerSessionDiskCache } from "./session";

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
/** The calls the latest snapshot lists as ringing, with the time each stops ringing. */
let streamCalls = new Map<string, number>();
/**
 * Calls the stream listed and then dropped: they ended on the server. A snapshot that never
 * listed a call proves nothing, since it may predate it. Each is kept only until its ring would
 * have expired, after which no native state can ring it anyway.
 */
let endedInStream = new Map<string, number>();
function pruneEndedCalls() {
  const now = Date.now();
  for (const [id, expiresAt] of endedInStream) if (!(expiresAt > now)) endedInStream.delete(id);
}
/** Resolves when the account stream has delivered its first snapshot, which covers every organization. */
let streamSnapshot: Promise<void> | undefined;
let snapshotArrived: (() => void) | undefined;
/** Cold-start waits for that snapshot, cancelled by stopIncomingCalls so none outlives its feed. */
const snapshotWaiters = new Set<() => void>();
/** How long a native or notification answer waits for that snapshot on a cold start. */
const SNAPSHOT_WAIT_MS = 5_000;

export function subscribeIncomingCalls(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** How many ended calls the stream still remembers; for tests of its bound. */
export function endedStreamCallCount() {
  return endedInStream.size;
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
    // Android's in-app screen takes over a ring it starts showing in the foreground, like the
    // rings it already showed when the app became active; otherwise both would ring.
    else if (previous?.incomingCall.callId !== call.callId)
      void native?.endIncomingCall(call.callId);
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
        // Ignore events from an aborted feed so a late callback cannot resolve a newer wait.
        if (controller.signal.aborted || feed !== controller) return;
        const listed = new Map(
          incoming.map((call) => [
            call.incomingCall.callId,
            Date.parse(call.incomingCall.expiresAt),
          ]),
        );
        for (const [id, expiresAt] of streamCalls)
          if (!listed.has(id)) endedInStream.set(id, expiresAt);
        for (const id of listed.keys()) endedInStream.delete(id);
        streamCalls = listed;
        pruneEndedCalls();
        snapshotArrived?.();
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
async function fetchRoster() {
  const generation = currentSessionGeneration();
  if (!(await loadSessionToken())) return;
  const navigation = await rpc("spaces/list");
  if (running && generation === currentSessionGeneration()) setIncomingCallRoster(navigation);
}
/** The roster request in flight; callers that arrive meanwhile share it instead of starting another. */
let rosterLoad: Promise<void> | undefined;
function loadRoster(): Promise<void> {
  if (rosterLoad) return rosterLoad;
  const load = fetchRoster().finally(() => {
    if (rosterLoad === load) rosterLoad = undefined;
  });
  rosterLoad = load;
  return load;
}

/**
 * Resolves the caller for a native or notification answer. The account stream knows callers
 * across every organization; the roster covers only the active one. A cached roster entry
 * answers at once. Otherwise the roster load races the stream's first snapshot, which a cold
 * start may not have yet, for a few seconds, and the first source to name the caller answers.
 * Returns undefined when the lookup's feed or session is gone: the answer belongs to neither,
 * so its caller abandons it without answering or completing the native action.
 */
async function callerFor(
  botId: string,
  callId: string,
): Promise<Pick<SpaceBot, "id" | "spaceId" | "name" | "color" | "avatarSet"> | null | undefined> {
  const generation = currentSessionGeneration();
  const startedFeed = feed;
  const stale = () => feed !== startedFeed || !running || generation !== currentSessionGeneration();
  const fromStream = () =>
    calls.find((entry) => entry.id === botId && entry.incomingCall.callId === callId) ?? null;
  const known = fromStream() ?? roster.get(botId);
  if (known) return known;
  // Whichever source names the caller first answers; a failed load surfaces only if neither does.
  const rostered = loadRoster();
  rostered.catch(() => undefined);
  if (streamSnapshot) {
    let stopWaiting: (() => void) | undefined;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<void>((resolve) => {
      stopWaiting = () => resolve();
      snapshotWaiters.add(stopWaiting);
    });
    try {
      await Promise.race([
        streamSnapshot,
        stopped,
        new Promise<void>((resolve) => {
          giveUp = setTimeout(resolve, SNAPSHOT_WAIT_MS);
        }),
        new Promise<void>((resolve) => {
          rostered.then(
            () => {
              if (roster.has(botId)) resolve();
            },
            () => undefined,
          );
        }),
      ]);
    } finally {
      clearTimeout(giveUp);
      if (stopWaiting) snapshotWaiters.delete(stopWaiting);
    }
    if (stale()) return undefined;
    const late = fromStream() ?? roster.get(botId);
    if (late) return late;
  }
  // The stream may name the caller after an empty snapshot, so a failed load throws only after it.
  const failure = await rostered.then(
    () => null,
    (error: unknown) => ({ error }),
  );
  if (stale()) return undefined;
  const caller = fromStream() ?? roster.get(botId);
  if (caller) return caller;
  if (failure) throw failure.error;
  return null;
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
      // The session changed mid-answer: rpc drops the hang-up below locally, because its
      // context belongs to the old generation, so the server keeps the call answered.
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
  // Answers first: an answer expires with its ring, while showing other rings can wait for the roster.
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
    const bot = await callerFor(action.botId, action.callId).catch(() => null);
    // A stale lookup answers nothing and completes no native action: a newer feed owns it.
    if (bot === undefined) continue;
    if (!bot) {
      await native?.finishAnswer(action.callId, false);
      continue;
    }
    await respondToMobileCall(
      { ...bot, incomingCall: { ...action, reason: "", opening: "" } },
      "answer",
    ).catch(() => undefined);
  }
  for (const ring of state.ringing ?? []) {
    if (!callIsRinging(ring)) continue;
    // A failed roster load only leaves this ring unshown.
    if (!roster.has(ring.botId)) await loadRoster().catch(() => undefined);
    // A ring the stream listed and then dropped has ended, for example answered on another
    // phone while the answers above were joining; the older native state must not bring it back.
    pruneEndedCalls();
    if (endedInStream.has(ring.callId)) continue;
    const bot = roster.get(ring.botId);
    if (bot) update(bot, { ...ring, reason: "", opening: "" });
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
    const bot = await callerFor(data.botId, data.callId);
    // A stale lookup answers nothing and completes no native action: a newer feed owns it.
    if (bot === undefined) return;
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
  streamSnapshot = undefined;
  snapshotArrived = undefined;
  streamCalls = new Map();
  endedInStream = new Map();
  // Cancel cold-start waits now; a continuation from this feed must not resume later.
  for (const stopWaiting of snapshotWaiters) stopWaiting();
  snapshotWaiters.clear();
  roster.clear();
  // A load in flight belongs to the stopped feed; the next one starts its own.
  rosterLoad = undefined;
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
  streamSnapshot = new Promise((resolve) => {
    snapshotArrived = resolve;
  });
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
        // A pending answer must not wait for the roster: callerFor races it with the stream.
        void loadRoster().catch(() => undefined);
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
