import { createConsoleSink } from "./console-sink.js";
import { createLogger, installLogger } from "./logger.js";

/**
 * Sends warnings and errors to the console, for a browser app that installs no other logger.
 * Without one the default logger is off, so `bestEffort` failures would leave no trace.
 */
export function installConsoleLogger(service: string): void {
  installLogger(
    createLogger({ service, level: "warn", sinks: [createConsoleSink({ format: "pretty" })] }),
  );
}
