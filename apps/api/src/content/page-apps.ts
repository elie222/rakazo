import { createHash, randomBytes } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import type { Actor, PageAbility, PageAppInstall } from "@rakazo/contracts";
import {
  knownPageAbilities,
  PAGE_APP_TOKEN,
  PAGE_APP_TOKEN_PREFIX,
  PageIconColorSchema,
} from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, requireMembership, runAsSystem } from "@rakazo/db";
import { actorFromMembership } from "../auth/request-session.js";

/** Enough for every device someone keeps; a runaway client stops here. */
const MAX_APPS_PER_USER = 50;
const LAST_USED_RESOLUTION_MS = 60 * 60_000;
const UNUSED_APP_GRACE_MS = 60 * 60_000;

export class TooManyPageAppsError extends ClientError {
  constructor() {
    super("CONFLICT", `You can install up to ${MAX_APPS_PER_USER} page apps`, "TOO_MANY_PAGE_APPS");
  }
}

export function hashPageAppToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function installPageApp(
  prisma: PrismaClient,
  jobs: JobPublisher,
  actor: Actor,
  input: { pageId: string; abilities: PageAbility[] },
): Promise<PageAppInstall> {
  const page = await prisma.page.findFirst({
    where: { id: input.pageId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true, title: true, icon: true, iconColor: true, currentVersion: true },
  });
  if (!page) throw new IsolationError();
  // Only what the page uses now is approved; a later version that adds more asks again.
  const used = await prisma.pageVersion.findUnique({
    where: { pageId_version: { pageId: page.id, version: page.currentVersion } },
    select: { abilities: true },
  });
  const approved = knownPageAbilities(input.abilities).filter((ability) =>
    used?.abilities.includes(ability),
  );
  const token = `${PAGE_APP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const app = await runAsSystem("install a page app", () =>
    prisma.$transaction(async (tx) => {
      // Serializes one person's installs so two at once cannot pass the cap together.
      await tx.$queryRaw`SELECT "id" FROM "user" WHERE "id" = ${actor.userId} FOR UPDATE`;
      if ((await tx.pageApp.count({ where: { userId: actor.userId } })) >= MAX_APPS_PER_USER)
        throw new TooManyPageAppsError();
      const created = await tx.pageApp.create({
        data: {
          pageId: page.id,
          userId: actor.userId,
          spaceId: actor.spaceId,
          tokenHash: hashPageAppToken(token),
          abilities: approved,
        },
        select: { id: true },
      });
      // An app's first read marks it used; one never read had its install fail on the device.
      await jobs.enqueueIn(tx, {
        name: "page.app-unused",
        payload: { appId: created.id },
        replaceKey: `page-app-unused:${created.id}`,
        availableAt: new Date(Date.now() + UNUSED_APP_GRACE_MS),
      });
      return created;
    }),
  );
  const color = PageIconColorSchema.safeParse(page.iconColor);
  return {
    appId: app.id,
    token,
    title: page.title,
    icon: page.icon,
    iconColor: color.success ? color.data : null,
  };
}

export async function removePageApp(prisma: PrismaClient, actor: Actor, appId: string) {
  await runAsSystem("remove a page app", () =>
    prisma.pageApp.deleteMany({ where: { id: appId, userId: actor.userId } }),
  );
  return { ok: true as const };
}

export type PageAppAccess = {
  appId: string;
  pageId: string;
  abilities: PageAbility[];
  actor: Actor;
};

/**
 * The app a bearer token belongs to, acting as its owner in the Space it was installed from.
 * Null for any token that is malformed, revoked, or whose owner can no longer act there.
 */
export async function pageAppFromToken(
  prisma: PrismaClient,
  authorization: string | undefined,
  now = new Date(),
): Promise<PageAppAccess | null> {
  const token = authorization?.match(/^Bearer (\S+)$/)?.[1];
  if (!token || !PAGE_APP_TOKEN.test(token)) return null;
  const app = await runAsSystem("read a page app token", () =>
    prisma.pageApp.findUnique({
      where: { tokenHash: hashPageAppToken(token) },
      select: {
        id: true,
        pageId: true,
        spaceId: true,
        abilities: true,
        lastUsedAt: true,
        user: { select: { id: true, email: true, deactivatedAt: true } },
      },
    }),
  );
  if (!app || app.user.deactivatedAt) return null;
  const actor = await actorFromMembership(requireMembership(prisma, app.user, app.spaceId));
  if (!actor) return null;
  if (!app.lastUsedAt || now.getTime() - app.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    await runAsSystem("mark a page app used", () =>
      prisma.pageApp.updateMany({ where: { id: app.id }, data: { lastUsedAt: now } }),
    );
  }
  return {
    appId: app.id,
    pageId: app.pageId,
    abilities: knownPageAbilities(app.abilities),
    actor,
  };
}

export async function setPageAppAbilities(
  prisma: PrismaClient,
  appId: string,
  abilities: PageAbility[],
): Promise<PageAbility[]> {
  const approved = knownPageAbilities(abilities);
  await runAsSystem("approve page app abilities", () =>
    prisma.pageApp.updateMany({ where: { id: appId }, data: { abilities: approved } }),
  );
  return approved;
}

export async function revokePageAppToken(prisma: PrismaClient, appId: string) {
  await runAsSystem("revoke a page app", () => prisma.pageApp.deleteMany({ where: { id: appId } }));
}

/** What an app shows of its page, as one value that differs whenever any of it changes. */
export async function pageAppVersion(
  prisma: PrismaClient,
  access: Pick<PageAppAccess, "pageId" | "actor">,
): Promise<string> {
  const [page, state] = await runAsSystem("read a page app's version", () =>
    Promise.all([
      prisma.page.findUnique({
        where: { id: access.pageId },
        select: { currentVersion: true, updatedAt: true, title: true, icon: true, iconColor: true },
      }),
      prisma.pageReaderState.findUnique({
        where: { pageId_userId: { pageId: access.pageId, userId: access.actor.userId } },
        select: { updatedAt: true },
      }),
    ]),
  );
  return JSON.stringify([page, state?.updatedAt ?? null]);
}
