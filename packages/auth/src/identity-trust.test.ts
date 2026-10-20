import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { bootstrapUserSpace } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "./index.js";

// Exercise Better Auth's real routing, password hashing, verification and
// session hooks with its official offline adapter. Only persistence is faked.
vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    prismaAdapter: (prisma: { authData: Record<string, unknown[]> }) =>
      memoryAdapter(prisma.authData),
  };
});
vi.mock("@rakazo/db", () => ({ bootstrapUserSpace: vi.fn(async () => ({ spaceId: "space-1" })) }));

function fixture({
  allowlist = "",
  delivery = true,
  baseURL = "http://auth.example.test",
  webOrigin = "http://web.example.test",
  requestOrigin,
  expireAdmissionGate,
}: {
  allowlist?: string;
  delivery?: boolean;
  baseURL?: string;
  webOrigin?: string;
  requestOrigin?: string;
  expireAdmissionGate?: "before" | "after";
} = {}) {
  const data: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
  };
  const policy: {
    signupsEnabled: boolean;
    signupAllowlist: string;
    signupPolicyInitialized: boolean;
    ownerUserId: string | null;
  } = {
    signupsEnabled: true,
    signupAllowlist: allowlist,
    signupPolicyInitialized: true,
    ownerUserId: null,
  };
  const messages: TransactionalEmail[] = [];
  const members = new Set<string>();
  const prisma = {
    authData: data,
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(
      async (
        run: ((tx: typeof prisma) => Promise<unknown>) | Promise<unknown>[],
        options?: { timeout?: number },
      ) => {
        if (Array.isArray(run)) return Promise.all(run);
        if (!expireAdmissionGate || options?.timeout === undefined) return run(prisma);
        if (expireAdmissionGate === "before") throw new Error("admission gate timeout");
        const pending = run(prisma);
        void pending.catch(() => undefined);
        for (let step = 0; step < 5; step += 1) await Promise.resolve();
        throw new Error("admission gate timeout");
      },
    ),
    deploymentSettings: {
      findUnique: vi.fn(async () => policy),
      updateMany: vi.fn(async ({ data: patch }: { data: { ownerUserId: string } }) => {
        if (policy.ownerUserId !== null) return { count: 0 };
        policy.ownerUserId = patch.ownerUserId;
        return { count: 1 };
      }),
    },
    user: {
      findMany: vi.fn(async () =>
        data
          .user!.filter((user) => !String(user.email).toLowerCase().endsWith("@messaging.invalid"))
          .slice(0, 2)
          .map((user) => ({ id: String(user.id) })),
      ),
      findFirst: vi.fn(async ({ where }: { where?: { id?: { not?: string } } }) => {
        const excluded = where?.id?.not;
        const other = data.user!.find(
          (user) =>
            (excluded === undefined || user.id !== excluded) &&
            !String(user.email).toLowerCase().endsWith("@messaging.invalid"),
        );
        return other ? { id: String(other.id) } : null;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data: patch,
        }: {
          where: { id: string };
          data: { emailVerified: boolean };
        }) => {
          const user = data.user!.find((item) => item.id === where.id);
          if (!user) return { count: 0 };
          Object.assign(user, patch);
          return { count: 1 };
        },
      ),
    },
    member: { findMany: vi.fn(async () => []) },
    messagingIdentity: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    organization: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    spaceMember: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string } }) =>
        members.has(where.userId) ? { spaceId: "space-1" } : null,
      ),
    },
  };
  vi.mocked(bootstrapUserSpace).mockImplementation(async (_prisma, user) => {
    members.add(user.id);
    return { spaceId: "space-1" };
  });
  const auth = createAuth(prisma as never, {
    secret: "offline-auth-secret-at-least-32-characters",
    baseURL,
    webOrigin,
    signupsEnabled: "true",
    signupAllowlist: "",
    email: delivery
      ? {
          describe: () => ({
            id: "offline-email",
            contractVersion: "1",
            adapterVersion: "1",
            capabilities: { transactional: true },
          }),
          send: async (message) => {
            messages.push(message);
          },
        }
      : undefined,
  });
  const request = (path: string, body?: unknown, token?: string) =>
    auth.handler(
      new Request(`${baseURL}/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          origin: requestOrigin ?? webOrigin,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  const signup = (email = "approved@example.test") =>
    request("/sign-up/email", {
      email,
      password: "offline-password12",
      name: "Test User",
      emailVerified: true,
      id: "msg-attacker-chosen-id",
    });
  const signin = (email = "approved@example.test") =>
    request("/sign-in/email", {
      email,
      password: "offline-password12",
    });
  const verify = () => {
    const url = new URL(messages.at(-1)!.text.match(/http:\/\/\S+/)![0]);
    return request(`${url.pathname.replace("/api/auth", "")}${url.search}`);
  };
  return { auth, request, signup, signin, verify, data, policy, messages, members };
}

beforeEach(() => vi.clearAllMocks());

describe("loopback trusted origins", () => {
  it("accepts Origin localhost when webOrigin is 127.0.0.1", async () => {
    const f = fixture({
      delivery: false,
      baseURL: "http://127.0.0.1:5173",
      webOrigin: "http://127.0.0.1:5173",
      requestOrigin: "http://localhost:5173",
    });
    expect((await f.signup()).status).toBe(200);
  });

  it("accepts Origin 127.0.0.1 when webOrigin is localhost", async () => {
    const f = fixture({
      delivery: false,
      baseURL: "http://localhost:5173",
      webOrigin: "http://localhost:5173",
      requestOrigin: "http://127.0.0.1:5173",
    });
    expect((await f.signup()).status).toBe(200);
  });
});

describe("identity trust through auth endpoints", () => {
  // These branches sit behind Better Auth's HTTP checks, so call the session hook directly.
  it.each([
    ["missing user", null],
    ["messaging identity", "msg-test@messaging.invalid"],
    ["email delivery", "approved@example.test"],
    ["disallowed email", "outsider@other.test", false],
    ["first-account claim denied", "approved@example.test", false],
  ])("codes required verification for %s", async (reason, email, delivery = true) => {
    const f = fixture({ allowlist: "@example.test", delivery });
    if (reason === "first-account claim denied") {
      f.data.user!.push({ id: "other-user", email: "other@example.test" });
    }
    const hook = f.auth.options.databaseHooks!.session!.create!.before!;
    await expect(
      hook(
        { userId: "pending-user" } as never,
        {
          path: "/sign-in/email",
          context: {
            internalAdapter: {
              findUserById: vi.fn(async () =>
                email ? { id: "pending-user", email, emailVerified: false } : null,
              ),
            },
          },
        } as never,
      ),
    ).rejects.toMatchObject({
      body: { code: "EMAIL_VERIFICATION_REQUIRED", message: "Email verification required" },
    });
  });

  it("returns a translation code when registration is closed", async () => {
    const f = fixture();
    f.policy.signupsEnabled = false;
    const response = await f.signup();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "REGISTRATION_CLOSED",
      message: "Registration is closed",
    });
  });

  it("keeps first-owner bootstrap and password signup available without email for open deployments", async () => {
    const f = fixture({ delivery: false });
    const response = await f.signup();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      token: string;
      user: { id: string; emailVerified: boolean };
    };
    expect(body.token).toEqual(expect.any(String));
    expect(body.user.emailVerified).toBe(false);
    expect(body.user.id).not.toBe("msg-attacker-chosen-id");
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
    expect((await f.signin()).status).toBe(200);
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
  });

  it("admits the first allowlisted account without email delivery and still blocks everyone else", async () => {
    const f = fixture({ allowlist: "@example.test", delivery: false });
    const disallowed = await f.signup("outsider@other.test");
    expect(disallowed.status).toBe(400);
    expect(await disallowed.json()).toMatchObject({
      code: "EMAIL_NOT_ALLOWED",
      message: "Email is not allowed to register",
    });
    expect(f.data.user).toHaveLength(0);
    const response = await f.signup();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; user: { emailVerified: boolean } };
    expect(body.token).toEqual(expect.any(String));
    expect(f.data.user).toHaveLength(1);
    expect(f.data.user![0]!.emailVerified).toBe(true);
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
    expect(
      await f.auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${body.token}` }),
      }),
    ).toMatchObject({ user: { emailVerified: true } });
    expect((await f.signin()).status).toBe(200);
    const second = await f.signup("second@example.test");
    expect(second.status).toBe(400);
    expect(await second.text()).toContain("Registration requires email delivery");
    expect(f.data.user).toHaveLength(1);
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
    expect(f.messages).toHaveLength(0);
  });

  it("admits only one of two overlapping allowlisted signups without delivery", async () => {
    const f = fixture({ allowlist: "@example.test", delivery: false });
    const [first, second] = await Promise.all([
      f.signup("one@example.test"),
      f.signup("two@example.test"),
    ]);
    const admitted = [first, second].filter((response) => response.status === 200);
    const denied = [first, second].filter((response) => response.status === 400);
    expect(admitted).toHaveLength(1);
    expect(denied).toHaveLength(1);
    expect(await denied[0]!.text()).toContain("Registration requires email delivery");
    expect(f.data.user).toHaveLength(1);
    expect(f.policy.ownerUserId).toBe(f.data.user![0]!.id);
  });

  it("keeps a completed signup when the admission gate expires after admission", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const f = fixture({
        allowlist: "@example.test",
        delivery: false,
        expireAdmissionGate: "after",
      });
      const response = await f.signup();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { token: string };
      expect(body.token).toEqual(expect.any(String));
      expect(f.data.user).toHaveLength(1);
      expect(f.data.user![0]!.emailVerified).toBe(true);
      expect(f.policy.ownerUserId).toBe(f.data.user![0]!.id);
      expect((await f.signin()).status).toBe(200);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("fails signup when the admission gate expires before an account exists", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const f = fixture({
        allowlist: "@example.test",
        delivery: false,
        expireAdmissionGate: "before",
      });
      const response = await f.signup();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      expect(response.status).toBe(500);
      expect(f.data.user).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not let an unverified account claim the owner seat while another human exists", async () => {
    const f = fixture({ allowlist: "@example.test", delivery: false });
    expect((await f.signup()).status).toBe(200);
    f.data.user![0]!.emailVerified = false;
    f.data.user!.push({
      id: "human-2",
      name: "Other",
      email: "other@example.test",
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect((await f.signin()).status).toBe(403);
    expect(f.policy.ownerUserId).toBe(f.data.user![0]!.id);
  });

  it("does not treat a messaging identity as the first account", async () => {
    const f = fixture({ allowlist: "approved@example.test", delivery: false });
    f.data.user!.push({
      id: "msg-1",
      name: "Messaging",
      email: "msg-sendblue15550001111@messaging.invalid",
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const response = await f.signup();
    expect(response.status).toBe(200);
    expect(f.data.user!.filter((user) => user.email === "approved@example.test")).toHaveLength(1);
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
  });

  it("keeps allowlisted signup closed without delivery once a human account exists", async () => {
    const f = fixture({ allowlist: "@example.test", delivery: false });
    f.data.user!.push({
      id: "human-1",
      name: "Owner",
      email: "owner@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const response = await f.signup("second@example.test");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Registration requires email delivery");
    expect(f.data.user).toHaveLength(1);
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
  });

  it("requires mailbox proof before creating a session, space or first-owner claim", async () => {
    const f = fixture({ allowlist: "approved@example.test" });
    expect((await f.signup("outsider@example.test")).status).toBe(400);
    const response = await f.signup();
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toMatchObject({ token: null, user: { emailVerified: false } });
    expect(f.data.session).toHaveLength(0);
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
    expect((await f.signin()).status).toBe(403);
    expect(f.messages).toHaveLength(2);
    expect((await f.request("/verify-email?token=forged-token")).status).not.toBe(200);
    expect(f.data.user![0]!.emailVerified).toBe(false);
    const verified = await f.verify();
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe("http://web.example.test/sign-in");
    expect(verified.headers.get("set-cookie")).toBeNull();
    expect(f.data.user![0]!.emailVerified).toBe(true);
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
    const signedIn = await f.signin();
    expect(signedIn.status).toBe(200);
    const { token } = (await signedIn.json()) as { token: string };
    expect(token).toEqual(expect.any(String));
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
    expect(
      await f.auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) }),
    ).toMatchObject({ user: { emailVerified: true } });
  });

  it("rechecks policy before admitting a verified but unprovisioned signup", async () => {
    const f = fixture({ allowlist: "@example.test" });
    await f.signup();
    await f.verify();
    f.policy.signupsEnabled = false;
    const response = await f.signin();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "REGISTRATION_CLOSED",
      message: "Registration is closed",
    });
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
    f.policy.signupsEnabled = true;
    f.policy.signupAllowlist = "someone-else@example.test";
    expect((await f.signin()).status).toBe(403);
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
  });

  it("gates existing unverified sessions and auth mutations when the live allowlist is enabled", async () => {
    const f = fixture();
    const signedUp = await f.signup();
    const cookie = signedUp.headers.get("set-cookie")!.split(";")[0]!;
    const { token } = (await signedUp.json()) as { token: string };
    expect(await f.auth.api.getSession({ headers: new Headers({ cookie }) })).not.toBeNull();
    f.policy.signupAllowlist = "@example.test";
    expect(await f.auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
    expect(await (await f.request("/get-session", undefined, token)).json()).toBeNull();
    expect(
      await f.auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) }),
    ).toBeNull();
    expect((await f.request("/update-user", { name: "Changed" }, token)).status).toBe(401);
    expect((await f.signin()).status).toBe(403);
    await f.verify();
    expect((await f.signin()).status).toBe(200);
  });

  it("does not leak request-local verification settings when signup policy changes", async () => {
    const f = fixture({ allowlist: "@example.test" });
    expect(await (await f.signup()).json()).toMatchObject({ token: null });
    f.policy.signupAllowlist = "";
    expect(await (await f.signup("open@example.test")).json()).toMatchObject({
      token: expect.any(String),
    });
    expect(f.messages).toHaveLength(1);
    f.policy.signupAllowlist = "@example.test";
    expect(await (await f.signup("restricted@example.test")).json()).toMatchObject({ token: null });
    expect(f.messages).toHaveLength(2);
  });

  it("reserves internal messaging emails across registration, recovery and email changes", async () => {
    const f = fixture();
    for (const email of [
      "msg-sendblue15550001111@messaging.invalid",
      "MSG-Test@MESSAGING.INVALID",
    ]) {
      expect((await f.signup(email)).status).toBe(400);
      expect((await f.signin(email)).status).toBe(400);
      expect((await f.request("/request-password-reset", { email })).status).toBe(400);
      expect((await f.request("/send-verification-email", { email })).status).toBe(400);
    }
    expect(f.data.user).toHaveLength(0);
    const { token } = (await (await f.signup()).json()) as { token: string };
    expect(
      (await f.request("/change-email", { newEmail: "msg-taken@messaging.invalid" }, token)).status,
    ).toBe(400);
    // An account preclaimed before this upgrade must not keep its session.
    f.data.user![0]!.email = "msg-taken@messaging.invalid";
    expect(await (await f.request("/get-session", undefined, token)).json()).toBeNull();
    expect((await f.request("/update-user", { name: "Changed" }, token)).status).toBe(401);
    expect(f.messages).toHaveLength(0);
  });
});

describe("session credentials", () => {
  it("lists and reads sessions without handing out their tokens", async () => {
    const f = fixture({ delivery: false });
    await f.signup();
    const tokens: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      tokens.push(((await (await f.signin()).json()) as { token: string }).token);
    }
    const listed = await f.request("/list-sessions", undefined, tokens[0]);
    expect(listed.status).toBe(200);
    const text = await listed.text();
    const sessions = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    for (const session of sessions) {
      expect(session).toMatchObject({ id: expect.any(String), userId: expect.any(String) });
      expect(session).not.toHaveProperty("token");
    }
    for (const token of tokens) expect(text).not.toContain(token);

    const current = await f.request("/get-session", undefined, tokens[0]);
    const body = (await current.json()) as { session: Record<string, unknown>; user: unknown };
    expect(body.user).toMatchObject({ email: "approved@example.test" });
    expect(body.session).not.toHaveProperty("token");
    const server = await f.auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${tokens[1]}` }),
    });
    expect(server?.session).not.toHaveProperty("token");
  });

  it("requires the password to delete an account, even from a fresh session", async () => {
    const f = fixture({ delivery: false });
    const { token } = (await (await f.signup()).json()) as { token: string };
    for (const body of [{}, { password: "" }, { password: "wrong-password12" }]) {
      const response = await f.request("/delete-user", body, token);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(f.data.user).toHaveLength(1);
    }
    const deleted = await f.request("/delete-user", { password: "offline-password12" }, token);
    expect(deleted.status).toBe(200);
    expect(f.data.user).toHaveLength(0);
  });
});
