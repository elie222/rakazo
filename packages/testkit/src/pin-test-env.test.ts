import type { AdapterContext } from "@rakazo/adapter-kit";
import { createSecretStore } from "@rakazo/adapters";
import { describe, expect, it, vi } from "vitest";
import { pinLocalSecretStore } from "./pin-secret-store.js";

const describeFast = process.env.VERIFY_PROVIDERS ? describe.skip : describe;
const itOffline = process.env.VERIFY_DATABASE ? it.skip : it;

describeFast("pnpm test emulator pin", () => {
  it("forces scripted runtime, fake sandbox, and in-memory wakeup", () => {
    expect(process.env.AGENT_RUNTIME).toBe("scripted");
    expect(process.env.RAKAZO_LIVE_MODEL_CATALOG).toBe("off");
    expect(process.env.SANDBOX_PROVIDER).toBe("fake");
    expect(process.env.WAKEUP_DRIVER).toBe("memory");
  });

  it("never enables billed media generation through inherited configuration", () => {
    expect(process.env.MEDIA_GENERATION_PROVIDER).toBe("disabled");
    expect(process.env.MEDIA_GENERATION_API_KEY).toBeUndefined();
  });

  it("never enables billed paid services through inherited configuration", () => {
    expect(process.env.PAID_SERVICES_PROVIDER).toBe("disabled");
    expect(process.env.PAID_SERVICES_API_KEY).toBeUndefined();
  });

  it("does not keep a live Composio key in the test process", () => {
    expect(process.env.COMPOSIO_API_KEY).toBeUndefined();
    expect(process.env.INTEGRATIONS_CATALOG_URL).toBeUndefined();
  });

  it("does not inherit live email delivery configuration", () => {
    expect(process.env.EMAIL_PROVIDER).toBeUndefined();
    expect(process.env.EMAIL_API_KEY).toBeUndefined();
    expect(process.env.SMTP_URL).toBeUndefined();
  });

  itOffline(
    "does not connect to an inherited database without an explicit integration flag",
    () => {
      expect(process.env.DATABASE_URL).toBeUndefined();
      expect(process.env.REALTIME_DATABASE_URL).toBeUndefined();
    },
  );

  it("keeps the secret store local even when the environment configures a remote one", async () => {
    expect(process.env.SECRET_STORE).toBe("encrypted");
    const remote = {
      SECRET_STORE: "infisical",
      INFISICAL_URL: "https://secret-store.invalid",
      INFISICAL_CLIENT_ID: "pin-test-client-id",
      INFISICAL_CLIENT_SECRET: "pin-test-client-secret",
      INFISICAL_PROJECT_ID: "pin-test-project",
      INFISICAL_ENVIRONMENT: "pin-test",
      INFISICAL_FOLDER: "/pin-test",
    };
    const saved = Object.fromEntries(Object.keys(remote).map((name) => [name, process.env[name]]));
    Object.assign(process.env, remote);
    vi.stubGlobal("fetch", () => {
      throw new Error("offline test must not reach the network");
    });
    try {
      pinLocalSecretStore();
      const store = createSecretStore("pin-test-encryption-key");
      const context: AdapterContext = {
        operationId: "pin-secret-store",
        traceId: "pin-secret-store",
        spaceId: "pin-test-space",
        userId: "pin-test-user",
        signal: new AbortController().signal,
      };
      await store.start();
      const record = await store.put("model key", context);
      expect(store.describe().id).toBe("app-encrypted");
      expect(record.ref.startsWith("infisical:v1:")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
