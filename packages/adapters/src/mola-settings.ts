// Added Mola as a sandbox provider
// Mola is an open-source instant computer provider that runs Linux VMs with full desktop access
import { defineApiComputerProvider } from "./computer-provider-descriptor.js";

export const molaComputerSettings = defineApiComputerProvider("mola", "Mola", [
  ["apiKey", "MOLA_API_KEY", "API key", "secret", true],
  ["apiUrl", "MOLA_API_URL", "API URL", "url", false],
]);
