import { describe, expect, it, vi } from "vitest";
import waitlistFunction from "../api/waitlist";
import {
  captureWaitlistSignup,
  normalizeWaitlistEmail,
  parseWaitlistBody,
} from "./waitlist";

describe("waitlist", () => {
  it("parses JSON and normalizes email addresses", () => {
    expect(parseWaitlistBody('{"email":" Person@Example.COM "}')).toEqual({
      email: " Person@Example.COM ",
    });
    expect(normalizeWaitlistEmail(" Person@Example.COM ")).toBe("person@example.com");
  });

  it("rejects malformed and oversized email addresses", () => {
    expect(normalizeWaitlistEmail("person@example")).toBeNull();
    expect(normalizeWaitlistEmail(`${"a".repeat(250)}@example.com`)).toBeNull();
    expect(parseWaitlistBody({ email: "person@example.com", contactNote: 42 })).toBeNull();
  });

  it("captures a deduplicated person in the marketing analytics project", async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      new Response(null, { status: 200 }),
    );
    await expect(
      captureWaitlistSignup(
        "person@example.com",
        { PUBLIC_POSTHOG_KEY: "public-project-token" },
        fetchImpl,
      ),
    ).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const call = fetchImpl.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call!;
    expect(String(url)).toBe("https://us.i.posthog.com/i/v0/e/");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const payload = JSON.parse(String(init?.body));
    expect(payload).toMatchObject({
      api_key: "public-project-token",
      event: "waitlist_joined",
      properties: {
        $process_person_profile: true,
        $set: { email: "person@example.com", waitlist_status: "joined" },
        $set_once: { waitlist_source: "rakazo.com" },
      },
    });
    expect(payload.distinct_id).toMatch(/^waitlist:[a-f0-9]{64}$/);
  });

  it("fails closed when the marketing project is not configured", async () => {
    const fetchImpl = vi.fn();
    await expect(captureWaitlistSignup("person@example.com", {}, fetchImpl)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an oversized body when content-length is missing", async () => {
    const request = new Request("https://rakazo.com/api/waitlist", {
      method: "POST",
      body: JSON.stringify({ email: `${"a".repeat(2_048)}@example.com` }),
      headers: { "content-type": "application/json" },
    });

    const response = await waitlistFunction.fetch(request);

    expect(response.status).toBe(400);
  });

  it.each(["declared", "streamed"] as const)(
    "does not wait on a hanging body cancel for %s oversize",
    async (kind) => {
      let cancelStarted = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(2_049));
        },
        cancel() {
          cancelStarted = true;
          return new Promise(() => undefined);
        },
      });
      const request = new Request("https://rakazo.com/api/waitlist", {
        method: "POST",
        headers: kind === "declared" ? { "content-length": "2049" } : undefined,
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" });

      const response = await waitlistFunction.fetch(request);
      expect(response.status).toBe(400);
      expect(cancelStarted).toBe(true);
    },
  );

  it("silently accepts submissions that fill the bot trap", async () => {
    const request = new Request("https://rakazo.com/api/waitlist", {
      method: "POST",
      body: JSON.stringify({ email: "person@example.com", contactNote: "filled by a bot" }),
      headers: { "content-type": "application/json" },
    });

    const response = await waitlistFunction.fetch(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
