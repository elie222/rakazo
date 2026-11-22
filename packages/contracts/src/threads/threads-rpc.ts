import { eventIterator, oc } from "@orpc/contract";
import * as z from "zod";
import { IncomingBotCallSchema } from "../bots/bot.js";
import { LOGIN_FIELD_LIMIT, LoginFieldInput } from "../bots/bot-secrets.js";
import { Id } from "../ids.js";
import {
  TOOL_QUESTION_FIELDS_MAX,
  ToolQuestionValueSchema,
} from "../integrations/tool-question.js";
import {
  CalendarResponse,
  NativeCalendarDeviceKey,
  NativeCalendarRequest,
} from "../personal-calendar/personal-calendar.js";
import { botId } from "../rpc/inputs.js";
import { SpaceChangeKind } from "../spaces/space.js";
import { ProductEventSchema } from "./events.js";
import {
  ExternalConversationPolicySchema,
  UpdateExternalConversationPolicyInput,
} from "./external-conversations.js";
import { MessageReactionSchema } from "./reactions.js";
import { SEARCH_QUERY_MAX_LENGTH, SearchQueryOutputSchema } from "./search.js";
import { ChatAlertSchema, ThreadMessagePageSchema, ThreadSnapshotSchema } from "./thread.js";
import {
  threadSendInput,
  threadSendOutput,
  threadSendWithRoutinesInput,
  threadTarget,
} from "./thread-send.js";

export const threadsRpc = {
  threads: {
    head: oc.input(threadTarget).output(
      z.object({
        threadId: Id,
        cursor: z.number().int().min(-1),
      }),
    ),
    get: oc.input(threadTarget).output(ThreadSnapshotSchema),
    messages: oc
      .input(
        threadTarget.safeExtend({
          before: z.number().int().nonnegative().optional(),
          includePeerRuns: z.boolean().optional(),
          includePeerReceipts: z.boolean().optional(),
          around: z
            .object({
              messageId: Id.optional(),
              seq: z.number().int().nonnegative().optional(),
            })
            .optional(),
        }),
      )
      .output(ThreadMessagePageSchema),
    subscribe: oc
      .input(threadTarget.safeExtend({ cursor: z.number().int().min(-1) }))
      .output(eventIterator(ProductEventSchema)),
    send: oc.input(threadSendInput).output(threadSendOutput),
    /**
     * A send that also test-runs the mentioned routines: the message and every run commit
     * together, keyed by the nonce. A separate procedure, because an API without it must
     * reject the call rather than strip the routines and send only the text.
     */
    sendWithRoutines: oc
      .input(threadSendWithRoutinesInput)
      .output(z.object({ routineRunIds: z.array(Id), send: threadSendOutput.optional() })),
    nativeCalendarPending: oc
      .input(botId.extend({ deviceKey: NativeCalendarDeviceKey }))
      .output(z.array(NativeCalendarRequest)),
    nativeCalendarClaim: oc
      .input(
        NativeCalendarRequest.pick({ id: true, runId: true, threadId: true }).extend({
          deviceKey: NativeCalendarDeviceKey,
        }),
      )
      .output(NativeCalendarRequest.nullable()),
    nativeCalendarResult: oc
      .input(
        NativeCalendarRequest.pick({ id: true, runId: true, threadId: true }).extend({
          deviceKey: NativeCalendarDeviceKey,
          response: CalendarResponse,
        }),
      )
      .output(z.object({ accepted: z.boolean() })),
    react: oc
      .input(
        threadTarget.safeExtend({
          messageId: Id,
          reaction: MessageReactionSchema,
          clientNonce: z.string().min(1).max(200),
        }),
      )
      .output(z.object({ ok: z.literal(true), runIds: z.array(Id).optional() })),
    stop: oc.input(threadTarget).output(z.object({ ok: z.literal(true) })),
    // Its own route, so a server without it refuses rather than stopping the whole chat.
    stopHelper: oc
      .input(threadTarget.safeExtend({ messageId: Id }))
      .output(z.object({ ok: z.literal(true) })),
    followUp: oc
      .input(
        threadTarget.safeExtend({
          text: z.string().min(1),
          /** Carries the call id, so a turn taken mid-run stays in the call's card. */
          clientNonce: z.string().min(1).max(200).optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    /** The client hung up: close the call card and let the bot finish what was asked on it. */
    endCall: oc
      // ":" separates the call id from the nonce suffix, so it can never appear inside one.
      .input(
        botId.safeExtend({
          callId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[^:]+$/),
          /** How long the call was connected, measured from pickup on the caller's client. */
          durationSeconds: z
            .number()
            .int()
            .nonnegative()
            .max(7 * 24 * 60 * 60)
            .optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    /** The user picked up the bot's call: returns what the bot opens with. */
    answerCall: oc
      .input(
        botId.safeExtend({
          callId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[^:]+$/),
        }),
      )
      .output(z.object({ opening: z.string(), reason: z.string() })),
    /** The user turned the bot's call down, asked for it later, or it rang out. */
    declineCall: oc
      .input(
        botId.safeExtend({
          callId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[^:]+$/),
          outcome: z.enum(["declined", "missed"]),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    clear: oc.input(threadTarget).output(z.object({ ok: z.literal(true) })),
    answer: oc
      .input(
        threadTarget
          .safeExtend({
            runId: Id,
            messageId: Id,
            answer: z.string(),
            /** Carries the call id for an answer spoken during a call. */
            clientNonce: z.string().min(1).max(200).optional(),
            /** A login card's answer, one per requested field; `answer` is then empty. */
            fields: z.array(LoginFieldInput).min(1).max(LOGIN_FIELD_LIMIT).optional(),
            /** A login card's answer from apps that predate `fields`; `answer` carries its password. */
            username: z.string().min(1).max(512).optional(),
            /** Only for a login card: use the login for this run only instead of saving it. */
            remember: z.literal(false).optional(),
            /** Turns down a pending secret request; `answer` is then empty. */
            dismiss: z.literal(true).optional(),
          })
          .refine(
            (input) => input.remember === undefined || Boolean(input.fields ?? input.username),
            {
              message: "Only a website login can be used without saving it",
              path: ["remember"],
            },
          )
          .refine(
            (input) =>
              input.dismiss
                ? input.answer === "" && !input.username && !input.fields && !input.clientNonce
                : input.fields
                  ? input.answer === "" && !input.username
                  : input.answer.length > 0,
            "Send either an answer or a dismissal",
          ),
      )
      .output(z.object({ ok: z.literal(true) })),
    /** Answers a tool's question card while its call waits; only the run's own user may. */
    answerToolQuestion: oc
      .input(
        threadTarget.safeExtend({
          messageId: Id,
          action: z.enum(["accept", "decline"]),
          values: z
            .record(z.string().max(64), ToolQuestionValueSchema)
            .refine((values) => Object.keys(values).length <= TOOL_QUESTION_FIELDS_MAX)
            .optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    /** `unreadAfterSeq`: the seq read up to before this call, null when nothing was unread. */
    markRead: oc
      .input(threadTarget)
      .output(z.object({ ok: z.literal(true), unreadAfterSeq: z.number().int().nullable() })),
    /** With `messageId`, the chat reads as unread from that message: the next open puts New above it. */
    markUnread: oc
      .input(threadTarget.and(z.object({ messageId: Id.optional() })))
      .output(z.object({ ok: z.literal(true) })),
    /** Hides the chat from the caller's list until `until`; null wakes it now. */
    snooze: oc
      .input(threadTarget.and(z.object({ until: z.iso.datetime({ offset: true }).nullable() })))
      .output(z.object({ ok: z.literal(true) })),
  },
  notifications: {
    /**
     * Run alerts for the signed-in user's chats in this space, live while connected. `roster`
     * says `spaces.list` may have changed, `computerUpdates` that `computer.updates` may have,
     * `runs` that `runs.list` and `routines.history` may have, `routines` that `routines.list`
     * may have, and `organizations` that `organizations.list` and `organizations.members.list`
     * may have; each is sent once when the stream opens.
     */
    subscribe: oc.output(
      eventIterator(
        z.object({
          type: z.enum([
            "alert",
            "roster",
            ...SpaceChangeKind.options,
            "organizations",
            "heartbeat",
          ]),
          alert: ChatAlertSchema.optional(),
        }),
      ),
    ),
    subscribeCalls: oc.output(
      eventIterator(
        z.object({
          type: z.enum(["incoming.calls", "heartbeat"]),
          payload: z.object({ calls: z.array(IncomingBotCallSchema) }).optional(),
        }),
      ),
    ),
    declineIncomingCall: oc
      .input(z.object({ callId: z.string().uuid() }))
      .output(z.object({ ok: z.literal(true) })),
    registerCallPush: oc
      .input(
        z
          .object({
            deviceId: z.string().uuid(),
            platform: z.enum(["ios", "android"]),
            expoToken: z.string().min(8).max(512).regex(/^\S+$/).optional(),
            voipToken: z
              .string()
              .regex(/^[a-fA-F0-9]{64,200}$/)
              .optional(),
          })
          .refine((value) =>
            Boolean(value.expoToken || (value.platform === "ios" && value.voipToken)),
          ),
      )
      .output(z.object({ ok: z.literal(true) })),
    registerPush: oc
      // No whitespace: the token store keeps the registering session on the next line.
      .input(
        z.object({
          token: z.string().min(8).max(512).regex(/^\S+$/),
          presentation: z.literal("android_sender").optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    unregisterPush: oc.output(z.object({ ok: z.literal(true) })),
    /**
     * Keeps this phone's live status card of the user's bots at work up to date. `following` is
     * false when the server cannot update the card or no bot is at work, so the app ends it.
     * Omit `token` to check server support before creating a card; this does not follow work.
     */
    followWorkActivity: oc
      .input(
        z.object({
          token: z
            .string()
            .regex(/^[a-fA-F0-9]{64,512}$/)
            .optional(),
        }),
      )
      .output(z.object({ following: z.boolean() })),
    /**
     * Lets the server start this phone's live status card when the user's bots get to work from
     * another device. `token` is the phone's token for starting cards, again whenever it changes.
     */
    registerWorkActivityStarts: oc
      .input(z.object({ token: z.string().regex(/^[a-fA-F0-9]{64,512}$/) }))
      .output(z.object({ ok: z.literal(true) })),
  },
  search: {
    query: oc
      .input(z.object({ q: z.string().max(SEARCH_QUERY_MAX_LENGTH) }))
      .output(SearchQueryOutputSchema),
  },
  links: {
    /**
     * The site icon for a link's origin as a small data URL, resolved and cached by the server.
     * `retry` means the server was too busy to look; the origin may still have an icon.
     */
    favicon: oc
      // The longest origin: a scheme, a 253-character host name and a port.
      .input(z.object({ origin: z.string().max("https://".length + 253 + ":65535".length) }))
      .output(z.object({ icon: z.string().nullable(), retry: z.boolean().optional() })),
  },
  externalConversations: {
    updatePolicy: oc
      .input(UpdateExternalConversationPolicyInput)
      .output(ExternalConversationPolicySchema),
  },
};
