import type { TransactionalEmail, TransactionalEmailProvider } from "@rakazo/adapter-kit";
import {
  allowlistedSignupAdmission,
  emailAllowed,
  firstAccountClaimDecision,
  isMessagingEmail,
  parseAllowlist,
  signupPolicyFromEnv,
} from "@rakazo/core";
import { bootstrapUserSpace, type PrismaClient } from "@rakazo/db";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer, organization } from "better-auth/plugins";

export interface AuthEnv {
  secret: string;
  baseURL: string;
  webOrigin: string;
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
  extraOrigins?: string[];
  email?: TransactionalEmailProvider;
  onEmailError?: (error: unknown) => void;
  beforeDeleteUser?: (userId: string) => Promise<void>;
}

export async function resolveSignupPolicy(
  prisma: Pick<PrismaClient, "deploymentSettings">,
  env: Pick<AuthEnv, "signupsEnabled" | "signupAllowlist">,
): Promise<{ enabled: boolean; allowlist: string[] }> {
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { signupsEnabled: true, signupAllowlist: true, signupPolicyInitialized: true },
  });
  if (settings?.signupPolicyInitialized) {
    return {
      enabled: settings.signupsEnabled,
      allowlist: parseAllowlist(settings.signupAllowlist),
    };
  }
  return signupPolicyFromEnv(env);
}

const signupGates = new Map<string, Array<() => Promise<void>>>();

/** Serializes first-account admission inside this process. */
let signupGateTail: Promise<void> = Promise.resolve();

/**
 * Transaction-scoped lock shared by every API process. Held from the
 * allowlist check until that signup finishes, so a second signup cannot
 * insert a user until the first one is visible.
 */
const FIRST_ACCOUNT_ADMISSION_LOCK = 872014;

function enqueueSignupGate(): { wait: Promise<void>; done: () => void } {
  let settle: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const wait = signupGateTail;
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    settle();
  };
  signupGateTail = gate;
  return { wait, done };
}

/**
 * Hold the first-account gate until the signup handler finishes, so a second
 * allowlisted signup cannot insert a user until the first one is visible.
 * The transaction commits on release, which drops the advisory lock.
 */
async function holdFirstAccountGate(prisma: PrismaClient): Promise<{
  admission: "open" | "needs-delivery";
  release: () => Promise<void>;
}> {
  const turn = enqueueSignupGate();
  await turn.wait;
  let resolveReady: (admission: "open" | "needs-delivery") => void = () => undefined;
  let rejectReady: (error: unknown) => void = () => undefined;
  let readySettled = false;
  const ready = new Promise<"open" | "needs-delivery">((resolve, reject) => {
    resolveReady = (admission) => {
      if (readySettled) return;
      readySettled = true;
      resolve(admission);
    };
    rejectReady = (error) => {
      if (readySettled) return;
      readySettled = true;
      reject(error);
    };
  });
  let releaseGate: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  // The catch must not rethrow. Nothing waits on this promise until the
  // signup's after hook, so a later timeout would otherwise be an unhandled
  // rejection. A failure after admission must not replace a completed signup:
  // the account may already exist, and a 500 would leave the client unable to
  // retry that address.
  const finished = prisma
    .$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FIRST_ACCOUNT_ADMISSION_LOCK})`;
        const otherHuman = await tx.user.findFirst({
          where: {
            NOT: { email: { endsWith: "@messaging.invalid", mode: "insensitive" } },
          },
          select: { id: true },
        });
        resolveReady(otherHuman ? "needs-delivery" : "open");
        await released;
      },
      { timeout: 20_000, maxWait: 10_000 },
    )
    .catch((error: unknown) => {
      rejectReady(error);
    })
    .finally(() => {
      turn.done();
    });
  try {
    const admission = await ready;
    return {
      admission,
      release: async () => {
        releaseGate();
        await finished;
      },
    };
  } catch (error) {
    turn.done();
    if (error instanceof APIError) throw error;
    throw new APIError("INTERNAL_SERVER_ERROR");
  }
}

function rememberSignupGate(email: string, release: () => Promise<void>) {
  const key = email.trim().toLowerCase();
  const pending = signupGates.get(key) ?? [];
  pending.push(release);
  signupGates.set(key, pending);
}

async function releaseSignupGate(email: string) {
  const key = email.trim().toLowerCase();
  const pending = signupGates.get(key);
  const release = pending?.shift();
  if (!pending?.length) signupGates.delete(key);
  await release?.();
}

/**
 * One allowlisted account may skip mailbox proof when nothing can send mail.
 * Admission is reserved before the user row is inserted. This claim is the
 * backstop: the deployment-settings row is locked, then a conditional owner
 * update lets only one overlapping signup win. Any other human account,
 * verified or not, denies the exemption.
 */
async function claimUnverifiedFirstAccount(prisma: PrismaClient, userId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM deployment_settings WHERE id = 'default' FOR UPDATE`;
    const [settings, otherHuman] = await Promise.all([
      tx.deploymentSettings.findUnique({
        where: { id: "default" },
        select: { ownerUserId: true },
      }),
      tx.user.findFirst({
        where: {
          id: { not: userId },
          NOT: { email: { endsWith: "@messaging.invalid", mode: "insensitive" } },
        },
        select: { id: true },
      }),
    ]);
    const decision = firstAccountClaimDecision({
      userId,
      ownerUserId: settings?.ownerUserId ?? null,
      otherHuman: otherHuman !== null,
    });
    if (decision === "deny") return false;
    if (decision === "claim") {
      const claimed = await tx.deploymentSettings.updateMany({
        where: { id: "default", ownerUserId: null },
        data: { ownerUserId: userId },
      });
      if (claimed.count !== 1) return false;
    }
    // The signup user can still be invisible here when this runs inside the
    // auth transaction. Mark the row when it is already committed; the caller
    // also updates it through the auth adapter.
    await tx.user.updateMany({
      where: { id: userId },
      data: { emailVerified: true },
    });
    return true;
  });
}

export function createAuth(prisma: PrismaClient, env: AuthEnv) {
  return betterAuth({
    appName: "Rakazo",
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: buildTrustedOrigins(env),
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      // Signup policy is mutable deployment state, so the request hook below
      // enforces it instead of freezing an environment value at process start.
      disableSignUp: false,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: env.email
        ? async ({ user, url }) => {
            // Keep the response timing generic. Production providers track and retry the promise,
            // while the composition root drains accepted delivery during graceful shutdown.
            void env.email
              ?.send(passwordResetEmail(user, url))
              .catch((error) => env.onEmailError?.(error));
          }
        : undefined,
    },
    emailVerification: {
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: env.email
        ? async ({ user, url }) => {
            const verificationUrl = new URL(url);
            verificationUrl.searchParams.set(
              "callbackURL",
              new URL("/sign-in", env.webOrigin).href,
            );
            await env.email!.send(verificationEmail(user.email, verificationUrl.href));
          }
        : undefined,
    },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          await env.beforeDeleteUser?.(user.id);
          const memberships = await prisma.member.findMany({
            where: { userId: user.id },
            select: {
              organizationId: true,
              organization: { select: { members: { select: { userId: true } } } },
            },
          });
          const personalOrganizationIds = memberships
            .filter(({ organization }) =>
              organization.members.every((member) => member.userId === user.id),
            )
            .map(({ organizationId }) => organizationId);

          await prisma.$transaction([
            prisma.deploymentSettings.updateMany({
              where: { ownerUserId: user.id },
              data: { ownerUserId: null },
            }),
            // Messaging identities are deliberately FK-free, so clear them
            // here or the unique address would point at a deleted bot forever.
            prisma.messagingIdentity.deleteMany({
              where: { userId: user.id },
            }),
            prisma.organization.deleteMany({
              where: { id: { in: personalOrganizationIds } },
            }),
          ]);
        },
      },
    },
    plugins: [
      bearer(),
      organization({
        allowUserToCreateOrganization: false,
        creatorRole: "owner",
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        for (const value of [ctx.body?.email, ctx.body?.newEmail]) {
          if (typeof value === "string" && isMessagingEmail(value)) {
            throw new APIError("BAD_REQUEST", { message: "Email is not available" });
          }
        }
        let policy =
          ctx.path === "/sign-up/email" || ctx.path === "/sign-in/email"
            ? await resolveSignupPolicy(prisma, env)
            : undefined;
        let requireEmailVerification = false;
        if (ctx.path === "/sign-up/email") {
          if (!policy?.enabled) {
            throw new APIError("BAD_REQUEST", { message: "Registration is closed" });
          }
          const email = String(ctx.body?.email ?? "");
          if (!emailAllowed(email, policy.allowlist)) {
            throw new APIError("BAD_REQUEST", { message: "Email is not allowed to register" });
          }
          if (policy.allowlist.length > 0 && !env.email) {
            const held = await holdFirstAccountGate(prisma);
            if (held.admission === "needs-delivery") {
              await held.release();
              throw new APIError("BAD_REQUEST", {
                message: "Registration requires email delivery",
              });
            }
            rememberSignupGate(email, held.release);
            requireEmailVerification = false;
          } else {
            requireEmailVerification =
              allowlistedSignupAdmission({
                allowlistSize: policy.allowlist.length,
                hasEmailDelivery: Boolean(env.email),
                existingHumanCount: 0,
              }) === "verify";
          }
        } else if (policy) {
          requireEmailVerification = policy.allowlist.length > 0;
        }
        // Return a request-local override; mutating the shared auth options
        // would leak a concurrent request's policy into another signup.
        return {
          context: {
            context: {
              ...(policy
                ? {
                    options: {
                      emailAndPassword: { requireEmailVerification },
                    },
                  }
                : {}),
              internalAdapter: {
                ...ctx.context.internalAdapter,
                // Authorize at lookup: bearer conversion happens after before
                // hooks, and auth mutations also read sessions through here.
                findSession: async (token: string) => {
                  const session = await ctx.context.internalAdapter.findSession(token);
                  if (!session || isMessagingEmail(session.user.email)) return null;
                  if (session.user.emailVerified) return session;
                  policy ??= await resolveSignupPolicy(prisma, env);
                  return policy.allowlist.length === 0 ? session : null;
                },
              },
            },
          },
        };
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-up/email") {
          await releaseSignupGate(String(ctx.body?.email ?? ""));
        }
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => {
            // The auth adapter can still be inside the signup transaction.
            const user = await ctx?.context.internalAdapter.findUserById(session.userId);
            const policy = await resolveSignupPolicy(prisma, env);
            if (!user || isMessagingEmail(user.email)) {
              throw new APIError("FORBIDDEN", { message: "Email verification required" });
            }
            if (!user.emailVerified && policy.allowlist.length > 0) {
              if (env.email || !emailAllowed(user.email, policy.allowlist)) {
                throw new APIError("FORBIDDEN", { message: "Email verification required" });
              }
              // Mailbox ownership is not proved. The claim serializes the exemption
              // so a second overlapping signup cannot take it as well.
              const admitted = await claimUnverifiedFirstAccount(prisma, user.id);
              if (!admitted || !ctx) {
                throw new APIError("FORBIDDEN", { message: "Email verification required" });
              }
              await ctx.context.internalAdapter.updateUser(user.id, { emailVerified: true });
            }
            // Unverified signup must not provision resources or claim the
            // deployment owner. Bootstrap only at the first admitted session.
            const membership = await prisma.spaceMember.findFirst({ where: { userId: user.id } });
            if (!membership) {
              if (!policy.enabled || !emailAllowed(user.email, policy.allowlist)) {
                throw new APIError("FORBIDDEN", { message: "Registration is closed" });
              }
              await bootstrapUserSpace(prisma, user, env);
            }
          },
        },
      },
      user: {
        create: {
          before: async (user) => {
            if (isMessagingEmail(user.email)) {
              throw new APIError("BAD_REQUEST", { message: "Email is not available" });
            }
          },
        },
        update: {
          before: async (user) => {
            if (user.email && isMessagingEmail(user.email)) {
              throw new APIError("BAD_REQUEST", { message: "Email is not available" });
            }
          },
        },
      },
    },
  });
}

export function verificationEmail(email: string, url: string): TransactionalEmail {
  return {
    to: email,
    subject: "Verify your Rakazo email",
    text: `Verify your email, then return to Rakazo to sign in:\n\n${url}\n\nThis link expires in one hour. If you did not register, ignore this email.`,
    html: `<p><a href="${escapeHtml(url)}">Verify email</a>, then return to Rakazo to sign in.</p><p>This link expires in one hour. If you did not register, ignore this email.</p>`,
  };
}

export function passwordResetEmail(
  user: { id: string; email: string; name: string },
  resetUrl: string,
): TransactionalEmail {
  const name = user.name.trim() || "there";
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(resetUrl);
  return {
    to: user.email,
    subject: "Reset your Rakazo password",
    text: [
      `Hi ${name},`,
      "",
      "Reset your Rakazo password using this link:",
      resetUrl,
      "",
      "This link expires in one hour. If you did not request this, you can ignore this email.",
    ].join("\n"),
    html: `<p>Hi ${safeName},</p><p>Reset your Rakazo password:</p><p><a href="${safeUrl}">Reset password</a></p><p>This link expires in one hour. If you did not request this, you can ignore this email.</p>`,
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

export type Auth = ReturnType<typeof createAuth>;

/** Assemble Better Auth trustedOrigins, adding localhost↔127.0.0.1 twins for loopback. */
export function buildTrustedOrigins(env: Pick<AuthEnv, "webOrigin" | "baseURL" | "extraOrigins">) {
  const configured = [env.webOrigin, env.baseURL, ...(env.extraOrigins ?? [])];
  const twins = [env.webOrigin, env.baseURL].flatMap(loopbackTwinOrigins);
  return [...new Set([...configured, ...twins])];
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/** Same-scheme/port localhost and 127.0.0.1 variants when `origin` is loopback. */
function loopbackTwinOrigins(origin: string): string[] {
  try {
    const url = new URL(origin);
    if (!isLoopbackHost(url.hostname)) return [];
    const twins: string[] = [];
    for (const host of ["localhost", "127.0.0.1"] as const) {
      if (host === url.hostname) continue;
      const twin = new URL(origin);
      twin.hostname = host;
      twins.push(twin.origin);
    }
    return twins;
  } catch {
    return [];
  }
}

export const blockedAuthPaths = [
  "/organization/create",
  "/organization/invite",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/remove-member",
  "/organization/update-member-role",
];
