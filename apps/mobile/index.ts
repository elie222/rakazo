import { installConsoleLogger } from "@rakazo/logging/console-logger";
import { installMobileEarlyErrorReporting } from "./lib/platform/monitoring";

// So failures handed to `bestEffort` show in the console instead of vanishing.
installConsoleLogger("mobile");
installMobileEarlyErrorReporting(require("expo-secure-store"), require("expo-application"));
require("./lib/platform/startup").startMobileStartupWatchdog();
require("./lib/platform/monitoring-bootstrap").startMobileMonitoring();
// Expo's entry registers the root component after the early error handler exists.
require("expo-router/entry");
