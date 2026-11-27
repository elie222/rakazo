import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, IsolationError } from "@rakazo/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mountPageWebApp } from "./page-web-app.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("page web app manifest and icons (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `page-web-app-org-${suffix}`;
  const spaceId = `page-web-app-space-${suffix}`;
  const owner = `page-web-app-owner-${suffix}`;
  const actorFor = (userId: string): Actor => ({
    userId,
    spaceId,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  });
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let pageId: string;
  const app = new Hono();

  const get = (path: string, userId = owner) =>
    app.request(path, { headers: { "x-test-user": userId } });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    const system = asSystem(prisma);
    await system.user.create({
      data: { id: owner, name: owner, email: `${owner}@rakazo.test`, emailVerified: false },
    });
    await system.organization.create({
      data: { id: organizationId, name: "Apps Org", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
    pageId = (
      await system.page.create({
        data: { spaceId, userId: owner, title: "Trip plan", icon: "plane", iconColor: "blue" },
      })
    ).id;
    mountPageWebApp(app, {
      prisma,
      sessionActor: async (request, requested) => {
        const userId = request.headers.get("x-test-user");
        if (userId === `removed-${suffix}`) throw new IsolationError();
        return userId && requested === spaceId ? actorFor(userId) : null;
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    const system = asSystem(prisma);
    await system.organization.deleteMany({ where: { id: organizationId } });
    await system.user.deleteMany({ where: { id: owner } });
    await close();
  });

  it("gives the owner a manifest that installs the page on its own", async () => {
    const response = await get(`/api/v1/pages/${pageId}/app.webmanifest?space=${spaceId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/manifest+json");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    const manifest = await response.json();
    expect(manifest).toMatchObject({
      id: `/page/${pageId}`,
      name: "Trip plan",
      short_name: "Trip plan",
      start_url: `/page/${pageId}?space=${spaceId}`,
      scope: `/page/${pageId}`,
      display: "standalone",
    });
    expect(manifest.icons.map((icon: { sizes: string; purpose: string }) => icon)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: "512x512", purpose: "any" }),
        expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
      ]),
    );
  });

  it("draws the icon at the size the file names", async () => {
    const response = await get(`/api/v1/pages/${pageId}/app-icon/180.png?space=${spaceId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const png = Buffer.from(await response.arrayBuffer());
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
  });

  it("answers anyone but the owner, and any other icon file, with 404", async () => {
    const statuses = await Promise.all([
      get(`/api/v1/pages/${pageId}/app.webmanifest?space=${spaceId}`, `stranger-${suffix}`),
      get(`/api/v1/pages/${pageId}/app-icon/512.png?space=${spaceId}`, `stranger-${suffix}`),
      get(`/api/v1/pages/${pageId}/app-icon/64.png?space=${spaceId}`),
      get(`/api/v1/pages/missing-${suffix}/app.webmanifest?space=${spaceId}`),
    ]).then((responses) => responses.map((response) => response.status));
    expect(statuses).toEqual([404, 404, 404, 404]);
  });

  it("answers someone removed from the page's Space with 404", async () => {
    const response = await get(
      `/api/v1/pages/${pageId}/app.webmanifest?space=${spaceId}`,
      `removed-${suffix}`,
    );
    expect(response.status).toBe(404);
  });
});
