import { writeFile } from "node:fs/promises";

const defaultUiLocale = process.env.VITE_DEFAULT_UI_LOCALE?.trim() || "";
const runtimeConfig = JSON.stringify({ defaultUiLocale });
const output = `globalThis.__RAKAZO_RUNTIME_CONFIG__ = ${runtimeConfig};\n`;

await writeFile(new URL("../dist/runtime-config.js", import.meta.url), output, "utf8");
