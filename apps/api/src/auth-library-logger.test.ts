import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, expect, it } from "vitest";
import { authLibraryLogger } from "./app.js";

afterEach(() => installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] })));

it("keeps the auth library's failures as warnings with their error", () => {
  const sink = createTestSink();
  installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
  const logger = authLibraryLogger("auth.request.failed");
  logger.log("error", "Failed to verify registration", new Error("Unexpected origin"));
  logger.log("error", "Failed to verify registration");
  expect(sink.events).toMatchObject([
    {
      level: "warn",
      message: "auth.request.failed",
      "error.message": "Failed to verify registration",
      error: { message: "Unexpected origin" },
    },
    { level: "warn", "error.message": "Failed to verify registration" },
  ]);
});
