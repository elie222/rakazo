import type { AuthEvent, AuthInteraction } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHATGPT_DEVICE_CODE_TTL_SECONDS,
  createChatGptDeviceCodeLogin,
} from "./pi-chatgpt-device-code.js";

const PROVIDER_BODY = "upstream proxy said: internal trace 7f3a";

type Answer = Response | Error;

function fakeProvider(answers: { code?: Answer[]; poll: Answer[]; token?: Answer[] }) {
  const queues = {
    code: answers.code ?? [Response.json({ device_auth_id: "dev-1", user_code: "ABCD-1234" })],
    poll: answers.poll,
    token: answers.token ?? [tokenAnswer()],
  };
  const calls: string[] = [];
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const step = url.endsWith("/usercode")
      ? "code"
      : url.endsWith("/deviceauth/token")
        ? "poll"
        : "token";
    calls.push(step);
    const queue = queues[step];
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (!answer) throw new Error(`no ${step} answer`);
    if (init?.signal?.aborted) throw init.signal.reason;
    if (answer instanceof Error) throw answer;
    return answer.clone();
  }) as typeof fetch;
  return {
    fetch: request,
    calls,
    count: (step: string) => calls.filter((call) => call === step).length,
  };
}

function tokenAnswer() {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } };
  const access = `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  return Response.json({ access_token: access, refresh_token: "refresh-1", expires_in: 3600 });
}

const approved = () =>
  Response.json({ authorization_code: "auth-code", code_verifier: "verifier" });
const pending = () => new Response("", { status: 403 });
const status = (code: number, body = PROVIDER_BODY) => new Response(body, { status: code });

function interaction(signal?: AbortSignal) {
  const events: AuthEvent[] = [];
  const value: AuthInteraction = {
    signal,
    prompt: async () => {
      throw new Error("no prompt expected");
    },
    notify: (event) => events.push(event),
  };
  return { value, events };
}

describe("ChatGPT device-code sign-in", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps waiting through provider errors and dropped connections until the person approves", async () => {
    const provider = fakeProvider({
      poll: [pending(), status(502), new TypeError("fetch failed"), status(503), approved()],
    });
    const { value, events } = interaction();
    const login = createChatGptDeviceCodeLogin({ fetch: provider.fetch })(value);

    await vi.advanceTimersByTimeAsync(5 * 5_000);

    await expect(login).resolves.toMatchObject({
      type: "oauth",
      refresh: "refresh-1",
      accountId: "acct-1",
    });
    expect(provider.count("poll")).toBe(5);
    expect(events).toEqual([
      expect.objectContaining({
        type: "device_code",
        userCode: "ABCD-1234",
        expiresInSeconds: CHATGPT_DEVICE_CODE_TTL_SECONDS,
      }),
    ]);
  });

  it("ends on a refusal without quoting the provider's response", async () => {
    const provider = fakeProvider({
      poll: [
        status(400, JSON.stringify({ error: { code: "access_denied", detail: PROVIDER_BODY } })),
      ],
    });
    const error = await createChatGptDeviceCodeLogin({ fetch: provider.fetch })(
      interaction().value,
    ).catch((failure: unknown) => failure as Error);

    expect(error.message).toContain("(status 400, access_denied)");
    expect(error.message).not.toContain(PROVIDER_BODY);
    expect(provider.count("poll")).toBe(1);
  });

  it("keeps waiting when a response body is cut off mid-read", async () => {
    const cutOff = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("terminated"));
          },
        }),
      );
    const provider = fakeProvider({ poll: [cutOff(), approved()] });
    const login = createChatGptDeviceCodeLogin({ fetch: provider.fetch })(interaction().value);

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(login).resolves.toMatchObject({ accountId: "acct-1" });
    expect(provider.count("poll")).toBe(2);
  });

  it("does not retry a token exchange whose answer was cut off, since the code may be spent", async () => {
    const provider = fakeProvider({
      poll: [approved()],
      token: [new TypeError("fetch failed"), tokenAnswer()],
    });
    const login = createChatGptDeviceCodeLogin({ fetch: provider.fetch })(interaction().value);

    await expect(login).rejects.toThrow("could not reach the provider");
    expect(provider.count("token")).toBe(1);
  });

  it("keeps only an OAuth error name from a refusal", async () => {
    const provider = fakeProvider({
      poll: [status(400, JSON.stringify({ error: `free text ${PROVIDER_BODY}` }))],
    });
    const error = await createChatGptDeviceCodeLogin({ fetch: provider.fetch })(
      interaction().value,
    ).catch((failure: unknown) => failure as Error);

    expect(error.message).toBe("Device sign-in poll failed (status 400).");
  });

  it("ends on a refusal even when it comes as a 403", async () => {
    const provider = fakeProvider({
      poll: [status(403, JSON.stringify({ error: "access_denied" }))],
    });
    await expect(
      createChatGptDeviceCodeLogin({ fetch: provider.fetch })(interaction().value),
    ).rejects.toThrow("access_denied");
  });

  it("keeps waiting through a 5xx whose body is JSON null or cut off", async () => {
    const cutOff = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError("terminated"));
        },
      }),
      { status: 400 },
    );
    const provider = fakeProvider({ poll: [status(502, "null"), cutOff, approved()] });
    const login = createChatGptDeviceCodeLogin({ fetch: provider.fetch })(interaction().value);

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(login).resolves.toMatchObject({ accountId: "acct-1" });
  });

  it("keeps waiting on a not-yet-approved answer with an unfamiliar code", async () => {
    const provider = fakeProvider({
      poll: [
        status(403, JSON.stringify({ error: { code: "deviceauth_authorization_unknown" } })),
        approved(),
      ],
    });
    const login = createChatGptDeviceCodeLogin({ fetch: provider.fetch })(interaction().value);

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(login).resolves.toMatchObject({ accountId: "acct-1" });
  });

  it("reads an account id from a top-level claim", async () => {
    const access = `h.${Buffer.from(JSON.stringify({ chatgpt_account_id: "acct-2" })).toString("base64url")}.s`;
    const provider = fakeProvider({
      poll: [approved()],
      token: [Response.json({ access_token: access, refresh_token: "r", expires_in: 3600 })],
    });
    await expect(
      createChatGptDeviceCodeLogin({ fetch: provider.fetch })(interaction().value),
    ).resolves.toMatchObject({ accountId: "acct-2" });
  });

  it("refuses a credential that is already expired", async () => {
    const provider = fakeProvider({
      poll: [approved()],
      token: [Response.json({ access_token: "a.b.c", refresh_token: "r", expires_in: 0 })],
    });
    await expect(
      createChatGptDeviceCodeLogin({ fetch: provider.fetch })(interaction().value),
    ).rejects.toThrow("invalid credential");
  });

  it("slows down when the provider asks", async () => {
    const provider = fakeProvider({
      poll: [status(403, JSON.stringify({ error: "slow_down" })), approved()],
    });
    const login = createChatGptDeviceCodeLogin({ fetch: provider.fetch })(interaction().value);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(provider.count("poll")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(login).resolves.toMatchObject({ accountId: "acct-1" });
  });

  it("says the code expired once its time runs out", async () => {
    const provider = fakeProvider({ poll: [status(500)] });
    const login = createChatGptDeviceCodeLogin({ fetch: provider.fetch })(interaction().value);
    const rejected = expect(login).rejects.toThrow("Sign-in expired.");

    await vi.advanceTimersByTimeAsync(CHATGPT_DEVICE_CODE_TTL_SECONDS * 1000 + 5_000);

    await rejected;
  });

  it("retries a code request and token exchange the provider failed briefly", async () => {
    const provider = fakeProvider({
      code: [status(503), Response.json({ device_auth_id: "dev-1", user_code: "ABCD-1234" })],
      poll: [approved()],
      token: [status(502), tokenAnswer()],
    });
    const login = createChatGptDeviceCodeLogin({ fetch: provider.fetch })(interaction().value);

    await vi.advanceTimersByTimeAsync(2_000);

    await expect(login).resolves.toMatchObject({ accountId: "acct-1" });
    expect(provider.calls).toEqual(["code", "code", "poll", "token", "token"]);
  });

  it("stops waiting when the sign-in is cancelled", async () => {
    const provider = fakeProvider({ poll: [pending()] });
    const controller = new AbortController();
    const login = createChatGptDeviceCodeLogin({ fetch: provider.fetch })(
      interaction(controller.signal).value,
    );
    const rejected = expect(login).rejects.toThrow("Sign-in cancelled.");

    await vi.waitFor(() => expect(provider.count("poll")).toBe(1));
    controller.abort(new Error("Sign-in cancelled."));
    await rejected;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(provider.count("poll")).toBe(1);
  });
});
