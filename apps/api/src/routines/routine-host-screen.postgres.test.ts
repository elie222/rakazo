import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSandboxProvider } from "@rakazo/adapters";
import { runAsSystem } from "@rakazo/db";
import { expect, it } from "vitest";
import { createApp } from "../app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const origin = "http://127.0.0.1:5173";

// Nothing clears an approval when the server's own screen is turned off and on again, so only a
// computer the owner paired counts for "Use my computer".
it.skipIf(!databaseUrl)("never offers Use my computer for the server's own screen", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rakazo-routine-host-screen-"));
  const email = `routine-host-screen-${Date.now()}@example.test`;
  const handles = await createApp({
    databaseUrl: databaseUrl!,
    dataDir,
    sandboxProvider: "docker",
    sandbox: new FakeSandboxProvider(),
    sandboxOptions: { hostComputerUrl: "http://127.0.0.1:9", hostComputerToken: "test-host-token" },
    agentRuntime: "scripted",
    wakeupDriver: "memory",
    signupsEnabled: "true",
    signupAllowlist: "",
    webOrigin: origin,
    authUrl: origin,
  });
  try {
    await runAsSystem("let bots use this computer", () =>
      handles.prisma.deploymentSettings.upsert({
        where: { id: "default" },
        create: { id: "default", computerHost: "this-mac" },
        update: { computerHost: "this-mac" },
      }),
    );
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, password: "test-password-123", name: "Host tester" }),
    });
    expect(signup.status).toBeLessThan(400);
    const cookie = signup.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const call = async (procedure: string, json: unknown) => {
      const response = await handles.app.request(`/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin },
        body: JSON.stringify({ json }),
      });
      return { status: response.status, json: (await response.json()).json };
    };
    const bot = await call("bots/create", {
      name: "Backups",
      title: "Backups",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const routine = await call("routines/create", {
      botId: bot.json.id,
      name: "Backups",
      prompt: "Check the backups",
      crons: ["0 9 * * *"],
      timezone: "UTC",
      active: false,
      notify: false,
    });
    expect(routine.status).toBe(200);
    const listed = await call("routines/list", { botId: bot.json.id });
    expect(listed.json[0]).not.toHaveProperty("useComputer");
    const approved = await call("routines/update", {
      routineId: routine.json.id,
      prompt: "Check the backups",
      useComputer: true,
    });
    expect(approved.status).toBe(400);
  } finally {
    await runAsSystem("remove the host screen tester", async () => {
      await handles.prisma.deploymentSettings.update({
        where: { id: "default" },
        data: { computerHost: null },
      });
      await handles.prisma.user.deleteMany({ where: { email } });
    });
    await handles.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});
