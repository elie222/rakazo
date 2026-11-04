import type { SCIMOptions } from "@better-auth/scim";
import { displayName, isMessagingEmail } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";

/** The one directory a deployment provisions from. */
export const DIRECTORY_CONNECTION_ID = "directory";

/** An account the directory turned off or back on, inside a SCIM request that may still fail. */
export interface DirectoryAccountChange {
  userId: string;
  active: boolean;
}

/** Shared with the main auth config so both read and write the same user field. */
export const DEACTIVATED_AT_FIELD = {
  deactivatedAt: { type: "date", required: false, input: false },
} as const satisfies NonNullable<BetterAuthOptions["user"]>["additionalFields"];

/**
 * SCIM 2.0 user provisioning for the deployment's identity provider, loaded only when the
 * operator sets a SCIM token. The token can read and write users, not groups.
 *
 * It runs as its own auth instance on the same database, because SCIM writes need database
 * transactions that sign-up and sign-in do not use. It serves only the SCIM routes and never
 * creates a session.
 *
 * A directory user whose email already has an account takes that account over without
 * changing its name or email, so the directory can turn it off. Otherwise the directory
 * creates the account. Turning a user off (or deleting it) deactivates the account and keeps
 * its content; a later create with the same external id finds it again.
 */
export async function createDirectory(
  prisma: PrismaClient,
  options: {
    token: string;
    secret: string;
    baseURL: string;
    logger?: BetterAuthOptions["logger"];
    /** The header carrying the client address the API resolved, as for the main auth config. */
    ipAddressHeader: string;
    onAccountChange: (change: DirectoryAccountChange) => void;
  },
): Promise<Directory> {
  const { scim } = await import("@better-auth/scim");
  const identity: SCIMOptions["identity"] = {
    resolveUser: async ({ resource }, { database }) => {
      const existing = await database.findOne<{ id: string }>({
        model: "user",
        where: [{ field: "email", value: resource.primaryEmail.toLowerCase() }],
      });
      return existing
        ? { action: "link", userId: existing.id, profile: "preserve" }
        : { action: "create" };
    },
    reconcileUser: async ({ userId, active }, { database }) => {
      const user = await database.findOne<{ deactivatedAt: Date | null }>({
        model: "user",
        where: [{ field: "id", value: userId }],
      });
      if (!user || active === !user.deactivatedAt) return;
      await database.update({
        model: "user",
        where: [{ field: "id", value: userId }],
        update: { deactivatedAt: active ? null : new Date() },
      });
      options.onAccountChange({ userId, active });
    },
  };
  const userData = async (user: { email?: string; name?: string }) => {
    if (user.email && isMessagingEmail(user.email))
      throw new APIError("BAD_REQUEST", { message: "Email is not available" });
    return {
      data: { ...user, ...(user.name !== undefined ? { name: displayName(user.name, "") } : {}) },
    };
  };
  return betterAuth({
    appName: "Rakazo",
    logger: options.logger,
    secret: options.secret,
    baseURL: options.baseURL,
    database: prismaAdapter(prisma, { provider: "postgresql", transaction: true }),
    // A directory's first sync sends one request per person from a few addresses.
    rateLimit: {
      enabled: process.env.NODE_ENV === "production",
      storage: "database",
      window: 60,
      max: 1200,
    },
    advanced: { ipAddress: { ipAddressHeaders: [options.ipAddressHeader] } },
    user: { additionalFields: DEACTIVATED_AT_FIELD },
    databaseHooks: {
      user: {
        create: { before: (user) => userData(user) },
        update: { before: (user) => userData(user) },
      },
    },
    plugins: [
      scim({
        connections: [
          {
            id: DIRECTORY_CONNECTION_ID,
            credentials: [
              {
                type: "bearer",
                id: "operator",
                token: options.token,
                scopes: ["scim.users.read", "scim.users.write"],
              },
            ],
          },
        ],
        identity,
      }),
    ],
  });
}

/** Serves the SCIM routes under the auth base path. */
export interface Directory {
  handler: (request: Request) => Promise<Response>;
}
