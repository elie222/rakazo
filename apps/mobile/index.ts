import { installMobileEarlyErrorReporting } from "./lib/monitoring";

installMobileEarlyErrorReporting(require("expo-secure-store"), require("expo-application"));
require("./lib/startup").startMobileStartupWatchdog();
require("./lib/monitoring-bootstrap").startMobileMonitoring();
// Expo's entry registers the root component after the early error handler exists.
require("expo-router/entry");
