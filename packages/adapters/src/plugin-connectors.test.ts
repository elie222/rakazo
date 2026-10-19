import { describe, expect, it, vi } from "vitest";
import type { PluginRepoFile } from "./plugin-connectors.js";
import {
  fetchGitHubRepo,
  parsePluginDirectory,
  parsePluginSource,
  pluginPreviewDto,
  previewPluginInstall,
} from "./plugin-connectors.js";

const SHA = "a".repeat(40);
const TREE = "b".repeat(40);
const schema = "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json";
const manifest = {
  $schema: schema,
  name: "example-plugin",
  version: "1.0.0",
  description: "Example",
};
const skill = "---\nname: example-skill\ndescription: Example skill\n---\n\nFollow these steps.\n";
function files(
  mcpServers: Record<string, unknown> = {
    remote: { type: "streamable-http", url: "https://tools.example.test/mcp" },
  },
): PluginRepoFile[] {
  return [
    { path: "plugin.json", content: JSON.stringify(manifest) },
    { path: "skills/example-skill/SKILL.md", content: skill },
    {
      path: "mcp.json",
      content: JSON.stringify({
        $schema: schema.replace("plugin.schema", "mcp.schema"),
        mcpServers,
      }),
    },
  ];
}
const parse = (input = files()) => parsePluginDirectory({ files: input, resolvedSha: SHA });

describe("plugin sources", () => {
  it.each([
    ["https://github.com/example/plugins", { gitUrl: "https://github.com/example/plugins" }],
    ["https://github.com/Example/Plugins", { gitUrl: "https://github.com/example/plugins" }],
    [
      "https://github.com/example/plugins.git@feature/plugins#one",
      { gitUrl: "https://github.com/example/plugins", ref: "feature/plugins", subdir: "one" },
    ],
    [
      "https://github.com/example/plugins/tree/main/one",
      { gitUrl: "https://github.com/example/plugins", ref: "main", subdir: "one" },
    ],
  ])("normalizes %s", (source, expected) => expect(parsePluginSource(source)).toEqual(expected));
  it.each([
    "http://github.com/a/b",
    "https://user:password@github.com/a/b",
    "https://github.com/a/b?token=secret",
    "https://github.com/a/b#../escape",
    "https://github.com/a/b#dir\\file",
    "https://github.com/a/b#%2e%2e/escape",
    "https://github.com/a/b#one#two",
    "not a url",
    "https://github.com:444/a/b",
  ])("rejects unsafe source %s", (source) => expect(() => parsePluginSource(source)).toThrow());
});

describe("portable plugin parser", () => {
  it.each(["1.0.0", "1.1.0"])("loads Agent Plugins %s skills and remote MCP", (version) => {
    const entries = files().map((file) => ({
      ...file,
      content: file.content.replaceAll("1.1.0", version),
    }));
    const preview = parse(entries);
    expect(preview).toMatchObject({
      format: "agent-plugins",
      name: "example-plugin",
      resolvedSha: SHA,
    });
    expect(preview.skills).toEqual([
      { name: "example-skill", description: "Example skill", content: skill },
    ]);
    expect(preview.mcpServers).toEqual([
      {
        name: "remote",
        transport: "streamable_http",
        endpoint: "https://tools.example.test/mcp",
        headers: {},
      },
    ]);
  });
  it.each([
    [".cursor-plugin/plugin.json", "cursor"],
    [".grok-plugin/plugin.json", "grok"],
  ])("loads legacy %s and http alias", (path, format) => {
    const preview = parse([
      { path, content: JSON.stringify({ name: "example-plugin", skills: "./skills/" }) },
      {
        path: ".mcp.json",
        content: JSON.stringify({
          mcpServers: { remote: { type: "http", url: "https://example.test/mcp" } },
        }),
      },
    ]);
    expect(preview.format).toBe(format);
    expect(preview.mcpServers[0]?.transport).toBe("streamable_http");
  });
  it("keeps loading valid components when siblings are invalid, local or editor-only", () => {
    const preview = parse([
      ...files({
        good: { type: "sse", url: "https://example.test/sse" },
        local: { type: "stdio", command: "sh", args: ["malicious.sh"] },
        invalid: { type: "sse", url: "https://user:password@example.test/" },
        unknown: { type: "other" },
      }),
      { path: "skills/bad/SKILL.md", content: "No frontmatter" },
      { path: "hooks/hook.sh", content: "do not run" },
    ]);
    expect(preview.skills).toHaveLength(1);
    expect(preview.mcpServers.map((s) => s.name)).toEqual(["good"]);
    expect(preview.skipped.map((s) => s.kind)).toEqual(
      expect.arrayContaining([
        "mcp_stdio",
        "mcp_invalid",
        "unsupported_transport",
        "skill_invalid",
        "editor_only",
      ]),
    );
  });
  it("rejects unknown manifest versions/invalid metadata; reports unknown fields", () => {
    expect(() =>
      parse([{ path: "plugin.json", content: JSON.stringify({ name: "example" }) }]),
    ).toThrow(/schema/);
    expect(() =>
      parse([{ path: "plugin.json", content: JSON.stringify({ ...manifest, name: "Bad Name" }) }]),
    ).toThrow(/metadata/);
    const result = parse([
      { path: "plugin.json", content: JSON.stringify({ ...manifest, custom: true }) },
    ]);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ kind: "unsupported_field", name: "custom" }),
    );
  });
  it("disables only MCP on schema mismatch or unknown top-level fields", () => {
    for (const config of [
      { $schema: "unknown", mcpServers: {} },
      { $schema: schema.replace("plugin.schema", "mcp.schema"), mcpServers: {}, extra: true },
    ]) {
      const preview = parse(
        files().map((f) => (f.path === "mcp.json" ? { ...f, content: JSON.stringify(config) } : f)),
      );
      expect(preview.skills).toHaveLength(1);
      expect(preview.mcpServers).toEqual([]);
      expect(preview.skipped[0]?.kind).toBe("mcp_invalid");
    }
  });
  it("does not recursively discover skills or silently lose companion resources", () => {
    const preview = parse([
      ...files(),
      { path: "skills/nested/deeper/SKILL.md", content: skill },
      { path: "skills/example-skill/references/guide.md", content: "guide" },
    ]);
    expect(preview.skills).toEqual([]);
    expect(preview.skipped[0]?.reason).toMatch(/companion files/);
  });
  it.each(["../plugin.json", "/plugin.json", "skills/../plugin.json", "dir\\plugin.json"])(
    "rejects escaping path %s",
    (path) => {
      expect(() => parse([{ path, content: "{}" }])).toThrow(/paths/);
    },
  );
  it("bounds file count and file size, rejects duplicate paths/names", () => {
    expect(() =>
      parse(Array.from({ length: 201 }, (_, i) => ({ path: `${i}`, content: "" }))),
    ).toThrow(/too many/);
    expect(() => parse([{ path: "plugin.json", content: "a".repeat(100_001) }])).toThrow(
      /too large/,
    );
    expect(() => parse([...files(), files()[0]!])).toThrow(/duplicate file/);
    expect(() => parse([...files(), { path: "skills/second/SKILL.md", content: skill }])).toThrow(
      /duplicate skill/,
    );
  });
  it("digests all manifest and component content independent of listing order", () => {
    const original = parse();
    expect(parse(files().reverse()).digest).toBe(original.digest);
    expect(parse(files().map((f) => ({ ...f, content: `${f.content}\n` }))).digest).not.toBe(
      original.digest,
    );
  });
  it("hides headers and skill bodies in public previews", () => {
    const preview = parse(
      files({
        remote: {
          type: "streamable-http",
          url: "https://example.test/mcp",
          headers: { "X-Tenant": "package-tenant" },
        },
      }),
    );
    const dto = pluginPreviewDto(preview);
    expect(JSON.stringify(dto)).not.toContain("package-tenant");
    expect(JSON.stringify(dto)).not.toContain("Follow these steps");
    expect(dto.mcpServers[0]?.staticHeaderKeys).toEqual(["X-Tenant"]);
  });
  it.each([
    { type: "sse", url: "https://example.test/mcp?api_key=fake-secret" },
    { type: "sse", url: "https://example.test/mcp", headers: { "X-Test": "injected\r\nheader" } },
    { type: "sse", url: "https://example.test/mcp", headers: { "X-Test": "one", "x-test": "two" } },
  ])("rejects unsafe queries or headers %j", (server) => {
    expect(parse(files({ remote: server })).mcpServers).toEqual([]);
  });

  it("skips unresolved legacy credential placeholders rather than leaking/substituting", () => {
    expect(
      parse(
        files({
          remote: {
            type: "sse",
            url: "https://example.test/mcp",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal untrusted plugin placeholder fixture
            headers: { Authorization: "Bearer ${TOKEN}" },
          },
        }),
      ).mcpServers,
    ).toEqual([]);
  });
});

describe("GitHub acquisition", () => {
  function reader(
    entries: Array<Record<string, unknown>> = [
      { path: "plugin.json", type: "blob", mode: "100644", size: 80 },
    ],
  ) {
    return vi.fn(async (url: string) => {
      if (url.includes("/commits/"))
        return JSON.stringify({ sha: SHA, commit: { tree: { sha: TREE } } });
      if (url.includes("/git/trees/")) return JSON.stringify({ tree: entries, truncated: false });
      return JSON.stringify(manifest);
    });
  }
  it("resolves once then fetches an immutable tree and raw files", async () => {
    const read = reader();
    const repo = await fetchGitHubRepo(
      parsePluginSource("https://github.com/example/plugin@main"),
      undefined,
      read,
    );
    expect(repo.resolvedSha).toBe(SHA);
    expect(read.mock.calls.map((c) => c[0])).toEqual([
      "https://api.github.com/repos/example/plugin/commits/main",
      `https://api.github.com/repos/example/plugin/git/trees/${TREE}?recursive=1`,
      `https://raw.githubusercontent.com/example/plugin/${SHA}/plugin.json`,
    ]);
  });
  it.each([
    { path: "plugin.json", mode: "120000", type: "blob" },
    { path: "skills", mode: "160000", type: "commit" },
    { path: "../plugin.json", mode: "100644", type: "blob" },
    { path: "plugin.json", mode: "100644", type: "blob", size: 100_001 },
  ])("rejects unsafe tree entry %j", async (entry) => {
    await expect(
      fetchGitHubRepo(
        parsePluginSource("https://github.com/example/plugin"),
        undefined,
        reader([entry]),
      ),
    ).rejects.toThrow();
  });
  it("rejects SHA mismatch, incomplete trees and unsupported hosts without file fetches", async () => {
    const read = reader();
    await expect(
      fetchGitHubRepo(
        parsePluginSource(`https://github.com/example/plugin@${TREE}`),
        undefined,
        read,
      ),
    ).rejects.toThrow(/pin/);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(
      fetchGitHubRepo(parsePluginSource("https://other.example/a/b"), undefined, read),
    ).rejects.toThrow(/github.com/);
    await expect(
      fetchGitHubRepo(parsePluginSource("https://github.com/a/b"), undefined, async (url) =>
        url.includes("commits")
          ? JSON.stringify({ sha: SHA, commit: { tree: { sha: TREE } } })
          : JSON.stringify({ tree: [], truncated: true }),
      ),
    ).rejects.toThrow(/incomplete/);
  });
  it("scopes to a monorepo plugin subdirectory", async () => {
    const preview = await previewPluginInstall({
      source: "https://github.com/example/plugins@main#one",
      fetcher: async () => ({
        resolvedSha: SHA,
        files: files().map((f) => ({ ...f, path: `one/${f.path}` })),
      }),
    });
    expect(preview.source.subdir).toBe("one");
    expect(preview.skills).toHaveLength(1);
  });
});
