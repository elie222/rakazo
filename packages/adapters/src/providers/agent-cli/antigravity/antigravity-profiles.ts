import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@rakazo/contracts";
import { ANTIGRAVITY_CLI_PROVIDER_ID } from "./provider-id.js";

const PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAntigravityProfileId(value: unknown): value is string {
  return typeof value === "string" && PROFILE_ID_PATTERN.test(value);
}

/**
 * Opt-in gate for exposing Antigravity CLI as a selectable multi-account provider in Settings.
 * Keeps multi-tenant / hosted deployments closed unless the operator explicitly enables it.
 */
export function antigravityCliEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.RAKAZO_ANTIGRAVITY_CLI?.trim().toLowerCase();
  if (flag === "true" || flag === "1") return true;
  if (flag === "false" || flag === "0") return false;
  return env.PI_DEFAULT_PROVIDER?.trim() === ANTIGRAVITY_CLI_PROVIDER_ID;
}

/** Persistent directory holding isolated per-account GEMINI_HOME folders for `agy acp`. */
export function antigravityProfilesRoot(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir = env.DATA_DIR?.trim();
  const base = dataDir ? resolve(dataDir) : join(homedir(), ".rakazo");
  return join(base, "antigravity-profiles");
}

export function antigravityProfileDir(
  profileId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!isAntigravityProfileId(profileId)) {
    throw new Error("Invalid Antigravity profile identifier.");
  }
  return join(antigravityProfilesRoot(env), profileId);
}

export async function ensureAntigravityProfileDir(
  profileId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const root = antigravityProfilesRoot(env);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = antigravityProfileDir(profileId, env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function removeAntigravityProfileDir(
  profileId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isAntigravityProfileId(profileId)) return;
  await rm(antigravityProfileDir(profileId, env), { recursive: true, force: true });
}

export interface AntigravityCatalogModel {
  id: string;
  label: string;
  reasoning: boolean;
  thinkingLevels?: ThinkingLevel[];
  images: boolean;
}

/**
 * Models exposed by Google's Antigravity ACP server (`agy acp`), mapped to base model ids
 * paired with ACP `thought_level` config options so Rakazo's native Thinking picker works.
 */
export const ANTIGRAVITY_CATALOG_MODELS: readonly AntigravityCatalogModel[] = [
  {
    id: "gemini-4-neon",
    label: "Gemini 4 Neon",
    reasoning: true,
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    images: true,
  },
  {
    id: "gemini-4-hydrogen",
    label: "Gemini 4 Hydrogen",
    reasoning: true,
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    images: true,
  },
  {
    id: "gemini-4-carbon",
    label: "Gemini 4 Carbon",
    reasoning: true,
    thinkingLevels: ["low", "medium", "high"],
    images: true,
  },
  {
    id: "gemini-4-argon",
    label: "Gemini 4 Argon",
    reasoning: true,
    thinkingLevels: ["low", "medium", "high"],
    images: true,
  },
  {
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    reasoning: true,
    thinkingLevels: ["low", "medium", "high"],
    images: true,
  },
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    reasoning: true,
    thinkingLevels: ["low", "medium", "high"],
    images: true,
  },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    reasoning: true,
    thinkingLevels: ["low", "medium", "high"],
    images: true,
  },
  {
    id: "gpt-oss-120b-medium",
    label: "GPT-OSS 120B (Medium)",
    reasoning: false,
    images: true,
  },
];
