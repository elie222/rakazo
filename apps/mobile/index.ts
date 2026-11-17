import { installMobileEarlyErrorReporting } from "./lib/platform/monitoring";

installMobileEarlyErrorReporting(require("expo-secure-store"), require("expo-application"));
require("./lib/platform/startup").startMobileStartupWatchdog();
require("./lib/platform/monitoring-bootstrap").startMobileMonitoring();
// Expo's entry registers the root component after the early error handler exists.
require("expo-router/entry");
