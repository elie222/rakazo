import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSandboxProvider } from "@rakazo/adapters";
import { expect, it } from "vitest";
import { createApp } from "../app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const webOrigin = "http://127.0.0.1:5173";

it.skipIf(!databaseUrl)("treats googlemail.com and gmail.com as one account", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rakazo-gmail-"));
  const handles = await createApp({
    databaseUrl: databaseUrl!,
    dataDir,
    sandboxProvider: "fake",
    sandbox: new FakeSandboxProvider(),
    agentRuntime: "scripted",
    wakeupDriver: "memory",
    signupsEnabled: "true",
    signupAllowlist: "",
    webOrigin,
    authUrl: webOrigin,
  });
  const local = `person.${Date.now()}`;
  const password = "test-password-123";
  const post = (path: string, body: object) =>
    handles.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", origin: webOrigin },
      body: JSON.stringify(body),
    });
  try {
    const signUp = await post("/api/auth/sign-up/email", {
      email: `${local}@GoogleMail.com`,
      password,
      name: "Person",
    });
    expect(signUp.status).toBe(200);
    const user = await handles.prisma.user.findUniqueOrThrow({
      where: { email: `${local}@gmail.com` },
    });

    const signIn = await post("/api/auth/sign-in/email", { email: `${local}@gmail.com`, password });
    expect(signIn.status).toBe(200);
    expect(((await signIn.json()) as { user: { id: string } }).user.id).toBe(user.id);

    const duplicate = await post("/api/auth/sign-up/email", {
      email: `${local}@gmail.com`,
      password,
      name: "Person",
    });
    expect(duplicate.status).not.toBe(200);
  } finally {
    await handles.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});
