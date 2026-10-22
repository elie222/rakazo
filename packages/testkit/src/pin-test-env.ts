import { afterAll } from "vitest";

const dom = (
  globalThis as typeof globalThis & {
    jsdom?: { window: { localStorage: unknown } };
  }
).jsdom;

if (dom) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  // Vitest skips host globals even when their getters return undefined.
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: dom.window.localStorage,
  });
  afterAll(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
}

/**
 * `pnpm test` must stay emulator-only even when a developer .env points at
 * Pi, Docker, Graphile, or live Composio. Opt-in canaries set VERIFY_PROVIDERS.
 */
if (!process.env.VERIFY_PROVIDERS) {
  process.env.RAKAZO_LIVE_MODEL_CATALOG = "off";
  process.env.AGENT_RUNTIME = "scripted";
  process.env.SANDBOX_PROVIDER = "fake";
  process.env.CLOUD_AGENT_PROVIDER = "emulator";
  process.env.MEDIA_GENERATION_PROVIDER = "disabled";
  delete process.env.MEDIA_GENERATION_API_KEY;
  delete process.env.CURSOR_API_KEY;
  process.env.WAKEUP_DRIVER = "memory";
  delete process.env.COMPOSIO_API_KEY;
  delete process.env.INTEGRATIONS_CATALOG_URL;
  if (!process.env.VERIFY_DATABASE) {
    delete process.env.DATABASE_URL;
    delete process.env.REALTIME_DATABASE_URL;
  }
}
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
delete process.env.OTEL_CAPTURE_CONTENT;
delete process.env.AXIOM_TOKEN;
delete process.env.AXIOM_DATASET;
delete process.env.SENTRY_DSN;
delete process.env.SENTRY_BROWSER_DSN;
if (!process.env.VERIFY_LOGGING) {
  process.env.LOG_LEVEL = "off";
}

// Tests must never export product analytics to a configured collector.
process.env.ANALYTICS_PROVIDER = "none";

// Postgres suites connect as the runtime login. A protected table reached
// without runAsTenant/runAsSystem returns nothing there, as in production, so
// fail the suite on it instead. Loaded only then: other tests need no database.
if (process.env.VERIFY_DATABASE) {
  const { drainUnscopedDatabaseAccess } = await import("@rakazo/db");
  afterAll(() => {
    const sites = drainUnscopedDatabaseAccess();
    if (sites.length) {
      throw new Error(
        `Database access without a tenant or system context:\n\n${sites.join("\n\n")}`,
      );
    }
  });
}
