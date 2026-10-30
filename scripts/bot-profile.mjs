#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { BotRuntimeProfile } from "../packages/contracts/src/bot-runtime-profile.ts";

function usage() {
  return "Usage: pnpm bot:profile <validate|diff|get|update> [file ...]";
}

const MAX_PROFILE_BYTES = 128 * 1024;
const MAX_JSON_DEPTH = 32;

async function readJson(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error.message}`);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_PROFILE_BYTES) {
    throw new Error(`Profile file exceeds ${MAX_PROFILE_BYTES} bytes`);
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) throw new Error(`Profile JSON exceeds maximum nesting depth (${MAX_JSON_DEPTH})`);
    } else if (char === "}" || char === "]") depth -= 1;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in profile file: ${error.message}`);
  }
}

function parseProfile(profile, label) {
  const result = BotRuntimeProfile.safeParse(profile);
  if (!result.success) {
    for (const issue of result.error.issues) {
      console.error(`${label} ${issue.path.join(".") || "profile"}: ${issue.message}`);
    }
    return null;
  }
  return result.data;
}

const sensitiveField = /(?:secret|password|passwd|token|credential|api[-_]?key|private[-_]?key|auth|session|cookie|bearer|access[-_]?key)/i;

function display(value, field) {
  return sensitiveField.test(field) ? "[REDACTED]" : JSON.stringify(value);
}

function diff(before, after, prefix = "") {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (prefix && sensitiveField.test(prefix)) {
    return [`${prefix}: [REDACTED] -> [REDACTED]`];
  }
  if (
    before && after &&
    typeof before === "object" && typeof after === "object" &&
    !Array.isArray(before) && !Array.isArray(after)
  ) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => diff(before[key], after[key], prefix ? `${prefix}.${key}` : key));
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length === after.length) {
      return before.flatMap((value, index) => diff(value, after[index], `${prefix}[${index}]`));
    }
    return [`${prefix}: [REDACTED] -> [REDACTED]`];
  }
  const field = prefix.split(".").at(-1).replace(/\[\d+\]$/, "");
  return [`${prefix}: ${display(before, field)} -> ${display(after, field)}`];
}

export async function run(args) {
  const [command, ...paths] = args;
  if (command === "validate" && paths.length === 1) {
    const profile = parseProfile(await readJson(paths[0]), "");
    if (profile === null) return 1;
    console.log("Profile is valid.");
    return 0;
  }
  if (command === "diff" && paths.length === 2) {
    const before = parseProfile(await readJson(paths[0]), "before");
    const after = parseProfile(await readJson(paths[1]), "after");
    if (before === null || after === null) return 1;
    const changes = diff(before, after);
    console.log(changes.length ? changes.join("\n") : "No changes.");
    return 0;
  }
  if (command === "get" || command === "update") {
    console.error("Remote profile access is unavailable. No standalone authenticated RPC setup is configured.");
    return 2;
  }
  console.error(usage());
  return 2;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
