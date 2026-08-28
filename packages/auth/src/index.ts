import { randomBytes } from "node:crypto";
import { emailAllowed, parseAllowlist, signupPolicyFromEnv } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { bearer, organization } from "better-auth/plugins";

export interface AuthEnv {
  secret: string;
  baseURL: string;
  webOrigin: string;
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
  extraOrigins?: string[];
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

function newId(): string {
  return randomBytes(16).toString("hex");
}

export function createAuth(prisma: PrismaClient, env: AuthEnv) {
  return betterAuth({
    appName: "Rakazo",
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: [env.webOrigin, env.baseURL, ...(env.extraOrigins ?? [])],
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      // Signup policy is mutable deployment state, so the request hook below
      // enforces it instead of freezing an environment value at process start.
      disableSignUp: false,
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
      before: async (ctx) => {
        const path = String((ctx as { path?: string }).path ?? "");
        if (!path.includes("sign-up")) return;
        const policy = await resolveSignupPolicy(prisma, env);
        if (!policy.enabled) {
          throw new APIError("BAD_REQUEST", { message: "Registration is closed" });
        }
        const email =
          typeof ctx.body === "object" && ctx.body && "email" in ctx.body
            ? String((ctx.body as { email?: string }).email ?? "")
            : "";
        if (email && !emailAllowed(email, policy.allowlist)) {
          throw new APIError("BAD_REQUEST", { message: "Email is not allowed to register" });
        }
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const orgId = newId();
            await prisma.organization.create({
              data: {
                id: orgId,
                name: "Personal",
                slug: `user-${user.id.slice(0, 12)}`,
                createdAt: new Date(),
              },
            });
            await prisma.member.create({
              data: {
                id: newId(),
                organizationId: orgId,
                userId: user.id,
                role: "owner",
                createdAt: new Date(),
              },
            });
            const existing = await prisma.deploymentSettings.findUnique({
              where: { id: "default" },
            });
            if (!existing) {
              const policy = signupPolicyFromEnv(env);
              await prisma.deploymentSettings.create({
                data: {
                  id: "default",
                  ownerUserId: user.id,
                  signupsEnabled: policy.enabled,
                  signupAllowlist: policy.allowlist.join(","),
                  signupPolicyInitialized: true,
                },
              });
            } else if (!existing.ownerUserId) {
              await prisma.deploymentSettings.update({
                where: { id: "default" },
                data: { ownerUserId: user.id },
              });
            }
            await prisma.memoryDocument.create({
              data: {
                workspaceId: orgId,
                userId: user.id,
                scope: "user",
                path: "MEMORY.md",
                content: "# User memory\n\nAccount-wide preferences live here.\n",
              },
            });
            await prisma.notificationPreference.create({
              data: {
                workspaceId: orgId,
                userId: user.id,
              },
            });
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

export const blockedAuthPaths = [
  "/organization/create",
  "/organization/invite",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/remove-member",
  "/organization/update-member-role",
];
