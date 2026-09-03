import { randomBytes } from "node:crypto";
import { signupPolicyFromEnv } from "@rakazo/core";
import type { PrismaClient } from "./client.js";

export interface SignupPolicyEnv {
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
}

function newId(): string {
  return randomBytes(16).toString("hex");
}

/** Prisma unique-constraint violation; anything else must still throw. */
function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

/**
 * Everything a brand-new user needs around their account row: a personal
 * organization, its default space, owner memberships for both boundaries,
 * deployment-owner claim, user memory, and notification preferences. Shared by
 * the Better Auth `user.create.after` hook and phone-identity provisioning so
 * both paths stay in lockstep.
 *
 * `claimDeploymentOwner: false` is for identities that did not sign up
 * through the app (phone provisioning): a first texter must never become
 * the deployment owner.
 */
export async function bootstrapUserSpace(
  prisma: PrismaClient,
  user: { id: string },
  env: SignupPolicyEnv,
  options: { claimDeploymentOwner?: boolean } = {},
): Promise<{ spaceId: string }> {
  const claimDeploymentOwner = options.claimDeploymentOwner ?? true;
  // Concurrent bootstraps for the same user (e.g. overlapping first phone
  // inbounds) race on every unique key below; each step either wins or
  // joins the winner's state instead of failing.
  const slug = `user-${user.id.slice(0, 12)}`;
  let orgId = newId();
  try {
    await prisma.organization.create({
      data: { id: orgId, name: "Personal", slug, createdAt: new Date() },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    orgId = (await prisma.organization.findUniqueOrThrow({ where: { slug } })).id;
  }
  await prisma.member
    .create({
      data: {
        id: newId(),
        organizationId: orgId,
        userId: user.id,
        role: "owner",
        createdAt: new Date(),
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  await prisma.space
    .create({
      data: {
        id: orgId,
        organizationId: orgId,
        name: "Personal",
        isDefault: true,
        createdByUserId: user.id,
        createdAt: new Date(),
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  await prisma.spaceMember
    .create({
      data: {
        id: newId(),
        spaceId: orgId,
        organizationId: orgId,
        userId: user.id,
        role: "owner",
        createdAt: new Date(),
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  const policy = signupPolicyFromEnv(env);
  await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      ownerUserId: claimDeploymentOwner ? user.id : null,
      signupsEnabled: policy.enabled,
      signupAllowlist: policy.allowlist.join(","),
      signupPolicyInitialized: true,
    },
    update: {},
  });
  if (claimDeploymentOwner) {
    // Conditional claim: only the first concurrent claimant wins the seat.
    await prisma.deploymentSettings.updateMany({
      where: { id: "default", ownerUserId: null },
      data: { ownerUserId: user.id },
    });
  }
  const hasMemory = await prisma.memoryDocument.findFirst({
    where: { spaceId: orgId, userId: user.id, scope: "user", path: "MEMORY.md" },
  });
  if (!hasMemory) {
    await prisma.memoryDocument
      .create({
        data: {
          spaceId: orgId,
          userId: user.id,
          scope: "user",
          path: "MEMORY.md",
          content: "# Space memory\n\nPreferences and context kept within this space live here.\n",
        },
      })
      .catch((error: unknown) => {
        if (!isUniqueViolation(error)) throw error;
      });
  }
  await prisma.notificationPreference
    .create({
      data: {
        spaceId: orgId,
        userId: user.id,
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  return { spaceId: orgId };
}
