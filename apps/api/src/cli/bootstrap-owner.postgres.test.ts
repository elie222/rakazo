import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createAuth } from "@rakazo/auth";
import { createDb, createPool } from "@rakazo/db";
import { expect, it } from "vitest";

const run = promisify(execFile);
const testDatabase = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;

it.skipIf(!testDatabase)(
  "bootstraps privately, closes signup and preserves the password on restart",
  async () => {
    if (!testDatabase) throw new Error("DATABASE_URL is required");
    const name = `railway_bootstrap_${randomUUID().replaceAll("-", "")}`;
    const admin = createPool(testDatabase);
    const url = new URL(testDatabase);
    url.pathname = `/${name}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    const { prisma, pool } = createDb(url.href);
    const env = {
      ...process.env,
      DATABASE_URL: url.href,
      OWNER_EMAIL: "owner@example.test",
      OWNER_PASSWORD: "bootstrap-test-password-12345",
      BETTER_AUTH_URL: "http://127.0.0.1:5173",
      BETTER_AUTH_SECRET: "bootstrap-test-secret-with-over-32-characters",
    };
    try {
      await run("pnpm", ["--filter", "@rakazo/db", "exec", "prisma", "migrate", "deploy"], { env });
      const boot = (password: string) =>
        run("pnpm", ["--filter", "@rakazo/api", "exec", "tsx", "src/cli/bootstrap-owner.ts"], {
          env: { ...env, OWNER_PASSWORD: password },
        });
      await boot(env.OWNER_PASSWORD);
      const owner = await prisma.user.findUniqueOrThrow({ where: { email: env.OWNER_EMAIL } });
      expect(
        await prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
      ).toMatchObject({ ownerUserId: owner.id, signupsEnabled: false });
      expect(await prisma.session.count()).toBe(0);
      const memberships = await prisma.spaceMember.count({ where: { userId: owner.id } });
      expect(memberships).toBeGreaterThan(0);
      await prisma.deploymentSettings.update({
        where: { id: "default" },
        data: { ownerUserId: null },
      });
      await expect(boot("wrong-recovery-password")).rejects.toThrow();
      expect(
        await prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
      ).toMatchObject({ ownerUserId: null });
      await boot(env.OWNER_PASSWORD);
      expect(
        await prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
      ).toMatchObject({ ownerUserId: owner.id, signupsEnabled: false });
      expect(await prisma.spaceMember.count({ where: { userId: owner.id } })).toBe(memberships);
      await boot("a-different-password-on-restart");
      expect(await prisma.user.count()).toBe(1);
      const auth = createAuth(prisma, {
        secret: env.BETTER_AUTH_SECRET,
        baseURL: env.BETTER_AUTH_URL,
        webOrigin: env.BETTER_AUTH_URL,
        signupsEnabled: "false",
        signupAllowlist: "",
      });
      const request = (path: string, body: object) =>
        auth.handler(
          new Request(`${env.BETTER_AUTH_URL}/api/auth/${path}/email`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: env.BETTER_AUTH_URL },
            body: JSON.stringify(body),
          }),
        );
      expect(
        (await request("sign-in", { email: env.OWNER_EMAIL, password: env.OWNER_PASSWORD })).status,
      ).toBe(200);
      expect(
        (
          await request("sign-in", {
            email: env.OWNER_EMAIL,
            password: "a-different-password-on-restart",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await request("sign-up", {
            name: "Stranger",
            email: "stranger@example.test",
            password: env.OWNER_PASSWORD,
          })
        ).status,
      ).toBe(400);
      expect(await prisma.user.count()).toBe(1);
    } finally {
      await prisma.$disconnect();
      await pool.end();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    }
  },
  60_000,
);
