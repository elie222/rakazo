import type { MeetingJoinRequest } from "@rakazo/adapter-kit";
import { MeetingCalendarScheduleRejected, RetryJobLaterError } from "@rakazo/adapter-kit";
import { cancelResponseBody, parseRetryAfter, readBoundedJsonResponse } from "@rakazo/core";
import { z } from "zod";
import { buildRecallBotConfig } from "./recall-meeting.js";

const botList = z.object({ results: z.array(z.object({ id: z.string().uuid() })) });
const createdBot = z.object({ id: z.string().uuid() });

/**
 * Bots reserved ahead of a meeting found outside the provider's own calendar integration.
 * One bot serves one Rakazo meeting session, found again through the session in its metadata.
 */
export class RecallScheduledBots {
  constructor(private readonly options: { origin: string; apiKey: string; fetch?: typeof fetch }) {}

  async schedule(request: MeetingJoinRequest, joinAt: Date, signal: AbortSignal) {
    const config = { ...buildRecallBotConfig(request), join_at: joinAt.toISOString() };
    const existing = await this.find(request.sessionId, signal);
    if (existing) {
      // Keep the name and signed camera page current. Close to the start, the provider
      // may refuse changes to a bot it is launching, which then keeps its settings.
      const response = await this.call(`bot/${existing}/`, signal, "PATCH", config);
      cancelResponseBody(response);
      if (!response.ok && ![400, 404, 409].includes(response.status)) {
        this.raise(response);
      }
      if (response.status !== 404) return existing;
    }
    const response = await this.call("bot/", signal, "POST", config);
    if (!response.ok) {
      cancelResponseBody(response);
      if ([400, 422].includes(response.status)) {
        throw new MeetingCalendarScheduleRejected("The provider rejected the scheduled meeting.");
      }
      this.raise(response);
    }
    return createdBot.parse(await readBoundedJsonResponse<unknown>(response, 64 * 1024, signal)).id;
  }

  async cancel(sessionId: string, externalId: string | null, signal: AbortSignal) {
    const id = externalId ?? (await this.find(sessionId, signal));
    if (!id) return;
    const removed = await this.call(`bot/${z.string().uuid().parse(id)}/`, signal, "DELETE");
    cancelResponseBody(removed);
    if (removed.ok || removed.status === 404) return;
    if (removed.status !== 400 && removed.status !== 405 && removed.status !== 409) {
      this.raise(removed);
    }
    // A bot that has already launched can no longer be deleted, only asked to leave.
    const left = await this.call(`bot/${id}/leave_call/`, signal, "POST");
    cancelResponseBody(left);
    if (!left.ok && left.status !== 400 && left.status !== 404) this.raise(left);
  }

  private async find(sessionId: string, signal: AbortSignal) {
    const query = new URLSearchParams({ metadata__meetingSessionId: sessionId });
    const response = await this.call(`bot/?${query}`, signal);
    if (!response.ok) {
      cancelResponseBody(response);
      this.raise(response);
    }
    const { results } = botList.parse(
      await readBoundedJsonResponse<unknown>(response, 2 * 1024 * 1024, signal),
    );
    return results[0]?.id ?? null;
  }

  private raise(response: Response): never {
    if (response.status === 429 || response.status === 507) {
      throw new RetryJobLaterError(parseRetryAfter(response.headers.get("retry-after")) ?? 30_000);
    }
    throw new Error(`Meeting provider returned HTTP ${response.status}.`);
  }

  private call(path: string, signal: AbortSignal, method = "GET", body?: unknown) {
    return (this.options.fetch ?? fetch)(new URL(`/api/v1/${path}`, this.options.origin), {
      method,
      headers: {
        Authorization: `Token ${this.options.apiKey}`,
        Accept: "application/json",
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      signal,
      redirect: "error",
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }
}
