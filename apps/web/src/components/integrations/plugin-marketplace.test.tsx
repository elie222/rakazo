// @vitest-environment jsdom
import type { CapabilityInstall, McpServer } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  preview: vi.fn(),
  install: vi.fn(),
  parts: vi.fn(),
  approve: vi.fn(),
  connect: vi.fn(),
  skills: vi.fn(),
  skill: vi.fn(),
}));
// One space, so no "Available in" choice appears.
vi.mock("./space-availability", () => ({
  AvailabilityControl: () => null,
  AvailabilityLabel: () => null,
  reachesOtherSpaces: () => false,
  useOwnSpaces: () => [],
}));

vi.mock("../../lib/rpc", () => ({
  rpc: {
    capabilities: { pluginPreview: api.preview, install: api.install, pluginParts: api.parts },
    mcp: { assignments: { approve: api.approve } },
    agentSkills: { list: api.skills, get: api.skill },
  },
}));
vi.mock("../../lib/mcp-connect", () => ({ connectMcpOauth: api.connect }));
vi.mock("@rakazo/chat-ui/web", () => ({
  useLinkFavicon: () => ({ icon: null, unusable: () => undefined }),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, other }: { value: number; other: string }) => other.replace("#", `${value}`),
}));
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children, summary }: { children?: ReactNode; summary?: ReactNode }) => (
    <div>
      {summary}
      {children}
    </div>
  );
  return {
    Disclosure: Container,
    Spinner: () => <span role="status" />,
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  };
});

import { PluginDetail } from "./plugin-marketplace";

const source = "https://github.com/example/notes";
const preview = {
  format: "agent-plugins" as const,
  name: "notes",
  version: "1.0.0",
  description: "Daily planning",
  author: null,
  homepage: null,
  repository: null,
  license: null,
  keywords: [],
  resolvedSha: "a".repeat(40),
  pinnedSource: `${source}@${"a".repeat(40)}`,
  digest: `sha256:${"b".repeat(64)}`,
  skills: Array.from({ length: 7 }, (_, i) => ({ name: `skill-${i}`, description: "Write" })),
  mcpServers: [
    {
      name: "notes-mcp",
      transport: "streamable_http" as const,
      endpoint: "https://notes.example.test/mcp",
      staticHeaderKeys: [],
    },
  ],
  skipped: [],
};
const install = {
  id: "plugin-1",
  kind: "plugin",
  name: "notes",
  source,
  version: preview.resolvedSha,
  digest: preview.digest,
  secretConfigured: false,
  config: preview,
  createdAt: "",
} as CapabilityInstall;
const server = {
  id: "server-1",
  installId: install.id,
  name: "notes: notes-mcp",
  endpoint: "https://notes.example.test/mcp",
  oauthStatus: "none",
  health: { status: "unknown", message: null, toolCount: null, checkedAt: null },
} as McpServer;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onChanged = vi.fn();
const onBack = vi.fn();
function button(name: string) {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}
const click = (name: string) =>
  act(async () => {
    button(name).click();
  });
async function render(
  props: { install?: CapabilityInstall; servers?: McpServer[]; pasted?: string } = {},
) {
  await act(async () =>
    root.render(
      <PluginDetail
        selection={{
          source: props.pasted ?? source,
          installedSource: props.pasted ?? source,
          name: "Notes",
        }}
        installs={props.install ? [props.install] : []}
        servers={props.servers ?? []}
        assigned={new Set()}
        activeBotId="bot-1"
        onBack={onBack}
        onChanged={onChanged}
      />,
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  api.preview.mockResolvedValue(preview);
  onChanged.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("plugin detail", () => {
  it("previews what a plugin adds and confirms the previewed digest", async () => {
    await render();
    expect(api.preview).toHaveBeenCalledWith({ source });
    expect(container.textContent).toContain("https://notes.example.test/mcp");
    expect(container.textContent).toContain("skill-4");
    expect(container.textContent).not.toContain("skill-5");
    await click("2 more");
    expect(container.textContent).toContain("skill-6");
    await click("Connect");
    expect(api.install).toHaveBeenCalledWith({
      kind: "plugin",
      name: "notes",
      source: preview.pinnedSource,
      pluginDigest: preview.digest,
      config: {},
      pluginParts: ["connector"],
    });
    expect(onChanged).toHaveBeenCalled();
    expect(api.approve).not.toHaveBeenCalled();
  });

  it("shows a rejected install without claiming it was added", async () => {
    api.install.mockRejectedValue(new Error("Plugin content changed"));
    await render();
    await click("Connect");
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "Plugin content changed",
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("signs in and enables an installed plugin's connector for the bot", async () => {
    api.connect.mockResolvedValue("cancelled");
    await render({ install, servers: [server] });
    expect(api.preview).not.toHaveBeenCalled();
    expect(container.textContent).toContain("notes-mcp");
    await click("Sign in");
    expect(api.connect).toHaveBeenCalledWith(server.id);
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Sign-in cancelled");
    await click("Use in this bot");
    expect(api.approve).toHaveBeenCalledWith({ botId: "bot-1", serverId: server.id });
  });

  it("removes the connector only after confirmation and keeps the skills", async () => {
    await render({ install, servers: [server] });
    await click("Remove");
    expect(api.parts).not.toHaveBeenCalled();
    await click("Confirm removal");
    expect(api.parts).toHaveBeenCalledWith({ id: install.id, parts: ["skills"] });
  });

  it("adds skills on their own, next to a connector", async () => {
    await render();
    await click("Add skills");
    expect(api.install).toHaveBeenCalledWith(expect.objectContaining({ pluginParts: ["skills"] }));
    expect(onChanged).toHaveBeenCalled();
  });

  it("adds a skill pack with one action and names parts it could not add", async () => {
    api.preview.mockResolvedValue({
      ...preview,
      mcpServers: [],
      skipped: [{ kind: "editor_only", name: "hooks/", reason: "Runs only inside an editor" }],
    });
    await render();
    expect(() => button("Add skills")).toThrow();
    expect(container.textContent).toContain("Not added: hooks/");
    await click("Add");
    expect(api.install).toHaveBeenCalledWith(expect.objectContaining({ pluginParts: ["skills"] }));
  });

  it("connects the managed app of the same brand instead of the plugin's connector", async () => {
    const onConnect = vi.fn();
    await act(async () =>
      root.render(
        <PluginDetail
          selection={{ source, installedSource: source, name: "Notes" }}
          installs={[]}
          servers={[]}
          assigned={new Set()}
          managed={{
            name: "Notes",
            logo: null,
            connected: false,
            connecting: false,
            onConnect,
            onManage: vi.fn(),
          }}
          onBack={onBack}
          onChanged={onChanged}
        />,
      ),
    );
    await click("Connect");
    expect(onConnect).toHaveBeenCalled();
    expect(api.install).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("https://notes.example.test/mcp");
  });

  it("opens an installed plugin skill's saved instructions", async () => {
    api.skills.mockResolvedValue([
      { id: "skill-db-1", name: "skill-1", source: "plugin", description: "", readOnly: true },
    ]);
    api.skill.mockResolvedValue({ content: "Follow the plugin steps." });
    await render({ install, servers: [server] });
    await click("skill-1Write");
    expect(api.skill).toHaveBeenCalledWith({ skillId: "skill-db-1" });
    expect(container.querySelector('[data-testid="plugin-skill-recipe"]')?.textContent).toBe(
      "Follow the plugin steps.",
    );
  });

  it("recognizes an install saved under the normalized form of a pasted URL", async () => {
    api.preview.mockResolvedValue({ ...preview, installedSource: source });
    await render({ install, servers: [server], pasted: `${source}.git` });
    expect(button("Remove")).toBeTruthy();
    expect(container.textContent).toContain("notes-mcp");
  });

  it("reports connectors that answer as connected", async () => {
    await render({
      install,
      servers: [{ ...server, health: { ...server.health, status: "ok" } }],
    });
    expect(container.querySelector('[aria-label="Connected"]')).not.toBeNull();
    expect(() => button("Sign in")).toThrow();
  });
});
