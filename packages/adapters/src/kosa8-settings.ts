import { defineApiComputerProvider } from "./computer-provider-descriptor.js";

export const kosa8ComputerSettings = defineApiComputerProvider("kosa8", "kosa8", [
  ["apiKey", "KOSA8_API_KEY", "API key", "secret", true],
  ["apiUrl", "KOSA8_API_URL", "API URL", "url", false],
]);
