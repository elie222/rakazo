import type { WorkspaceExportLimits } from "@rakazo/adapter-kit";
import { shellQuote } from "@rakazo/core/node/desktop-runtime";

/** The most one save copies; a larger home keeps running unsaved. */
export const WORKSPACE_SAVE_LIMITS: WorkspaceExportLimits = {
  maxBytes: 5 * 1024 ** 3,
  maxFiles: 1_000_000,
};

const browserDirectories = [
  "Cache",
  "Code Cache",
  "CacheStorage",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GraphiteDawnCache",
  "Crashpad",
  "startup_cache",
  "cache2",
  // Components and models the browser downloads again on its own; each copy is per bot.
  "ActorSafetyLists",
  "CertificateRevocation",
  "component_crx_cache",
  "Crowd Deny",
  "DeferredBrowserMetrics",
  "Dictionaries",
  "extensions_crx_cache",
  "hyphen-data",
  "OnDeviceHeadSuggestModel",
  "optimization_guide_model_store",
  "OptimizationHints",
  "PKIMetadata",
  "Safe Browsing",
  "SafetyTips",
  "screen_ai",
  "Subresource Filter",
  "WasmTtsEngine",
  "WidevineCdm",
  "ZxcvbnData",
];
const browserFiles = [
  "BrowserMetrics",
  "BrowserMetrics-spare.pma",
  "DevToolsActivePort",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  ".parentlock",
  "lock",
];
const alternatives = (names: readonly string[]) =>
  names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

// POSIX extended expressions also run in GNU find. Keep the policy here, including the
// browser's historical name matching, rather than maintaining separate shell exclusions.
const exclusions = [
  {
    pattern:
      "(.*/)?(\\.cache|\\.npm|\\.pnpm-store|node_modules|\\.venv|__pycache__|\\.next|\\.turbo|\\.yarn/cache)",
    kind: "directory",
  },
  { pattern: "(.*/)?([^/]*\\.log|core|core\\.[0-9]+)", kind: "file" },
  { pattern: `\\.browser-profiles/(.*/)?(${alternatives(browserDirectories)})`, kind: "any" },
  { pattern: `\\.browser-profiles/(.*/)?(${alternatives(browserFiles)})`, kind: "entry" },
] as const;
const rules = exclusions.map((rule) => ({ ...rule, regex: new RegExp(`^${rule.pattern}$`) }));

/** Paths are relative to the home; file patterns never exclude directories. */
export function shouldSkipPortableWorkspaceFile(relative: string, isDirectory = false): boolean {
  const segments = relative.replace(/^\.\//, "").split("/");
  return rules.some((rule) =>
    segments.some((_, index) => {
      const last = index === segments.length - 1;
      if (rule.kind === "file" && (!last || isDirectory)) return false;
      if (rule.kind === "directory" && last && !isDirectory) return false;
      if (rule.kind === "entry" && !last) return false;
      return rule.regex.test(segments.slice(0, index + 1).join("/"));
    }),
  );
}

/** Run find from the home with `.`; excluded directories are never descended into. */
export function workspaceSaveFindExpression(): string {
  const expressions = exclusions.map(({ pattern, kind }) => {
    const type = kind === "directory" ? "-type d " : kind === "file" ? "-type f " : "";
    return `\\( ${type}-regex ${shellQuote(`./${pattern}`)} \\)`;
  });
  return `-regextype posix-extended \\( ${expressions.join(" -o ")} \\) -prune -o -type f`;
}
