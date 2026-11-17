import type { PluginPreview } from "@rakazo/contracts";
import type { ParsedPlugin } from "./plugin-connectors.js";

/** Public preview deliberately excludes skill bodies and all header values. */
export function pluginPreviewDto(plugin: ParsedPlugin): PluginPreview {
  return {
    format: plugin.format === "agent-skills" ? "agent-plugins" : plugin.format,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    author: plugin.author,
    homepage: plugin.homepage,
    repository: plugin.repository,
    license: plugin.license,
    keywords: plugin.keywords,
    resolvedSha: plugin.resolvedSha,
    digest: plugin.digest,
    skipped: plugin.skipped,
    builtinNames: plugin.builtinNames,
    skills: plugin.skills.map(({ name, description, files }) => ({
      name,
      description,
      ...(files ? { files: Object.keys(files).sort() } : {}),
    })),
    mcpServers: plugin.mcpServers.map(({ name, transport, endpoint, headers }) => ({
      name,
      transport,
      endpoint,
      staticHeaderKeys: Object.keys(headers),
    })),
  };
}
