import { installMobileEarlyErrorReporting } from "./lib/monitoring";

installMobileEarlyErrorReporting();
require("./lib/monitoring-bootstrap").startMobileMonitoring();
// Expo's entry registers the root component after the early error handler exists.
require("expo-router/entry");
