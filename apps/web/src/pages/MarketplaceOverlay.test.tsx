// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  catalog: vi.fn(),
  list: vi.fn(),
  preview: vi.fn(),
  install: vi.fn(),
  remove: vi.fn(),
  servers: vi.fn(),
  assignments: vi.fn(),
  approve: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({
  rpc: {
    marketplace: { catalog: api.catalog },
    capabilities: {
      list: api.list,
      pluginPreview: api.preview,
      install: api.install,
      remove: api.remove,
    },
    mcp: {
      servers: { list: api.servers },
      assignments: { list: api.assignments, approve: api.approve },
    },
  },
}));
vi.mock("../lib/mcp-connect", () => ({ connectMcpOauth: api.connect }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Container,
    DialogContent: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    DialogClose: Container,
    Badge: Container,
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
  };
});

import { MarketplaceOverlay } from "./MarketplaceOverlay";

const source = "https://github.com/example/notes";
const entry = {
  id: "notes",
  name: "notes",
  description: "Daily planning",
  keywords: [],
  registry: "Cursor",
  source,
  installedSource: source,
};
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
  skills: [{ name: "daily-notes", description: "Write notes" }],
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
};
const server = {
  id: "server-1",
  installId: install.id,
  name: "notes: notes-mcp",
  endpoint: "https://notes.example.test/mcp",
  oauthStatus: "none",
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function button(name: string) {
  const found = [...container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(name),
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}
const click = async (name: string) =>
  act(async () => {
    button(name).click();
  });
async function render(initialTab?: "installed") {
  await act(async () =>
    root.render(
      <MarketplaceOverlay onClose={() => undefined} activeBotId="bot-1" initialTab={initialTab} />,
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  api.catalog.mockResolvedValue({ entries: [entry], unavailableRegistries: [], skippedEntries: 0 });
  api.list.mockResolvedValue([]);
  api.preview.mockResolvedValue(preview);
  api.servers.mockResolvedValue([]);
  api.assignments.mockResolvedValue([]);
  api.install.mockImplementation(async () => {
    api.list.mockResolvedValue([install]);
    api.servers.mockResolvedValue([server]);
    return install;
  });
  api.remove.mockImplementation(async () => {
    api.list.mockResolvedValue([]);
    api.servers.mockResolvedValue([]);
    return { ok: true };
  });
  api.connect.mockResolvedValue("cancelled");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("plugin marketplace", () => {
  it("previews before confirming Add and guides linked servers without granting bot access", async () => {
    await render();
    await click("notes");
    expect(api.install).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Write notes");
    expect(container.textContent).toContain("https://notes.example.test/mcp");
    await click("Add plugin");
    expect(api.install).toHaveBeenCalledWith({
      kind: "plugin",
      name: "notes",
      source: preview.pinnedSource,
      pluginDigest: preview.digest,
      config: {},
    });
    expect(button("Sign in")).toBeTruthy();
    expect(api.approve).not.toHaveBeenCalled();
    await click("Use in this bot");
    expect(api.approve).toHaveBeenCalledWith({ botId: "bot-1", serverId: server.id });
  });
  it("keeps cancelled sign-in recoverable and reads connected state after successful OAuth", async () => {
    api.list.mockResolvedValue([install]);
    api.servers.mockResolvedValue([server]);
    await render("installed");
    await click("notes");
    await click("Sign in");
    expect(container.textContent).toContain("Sign-in cancelled");
    expect(button("Sign in")).toBeTruthy();
    api.connect.mockImplementationOnce(async () => {
      api.servers.mockResolvedValue([{ ...server, oauthStatus: "connected" }]);
      return "connected";
    });
    await click("Sign in");
    expect(api.connect).toHaveBeenCalledWith(server.id, { returnToMarketplace: true });
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).not.toContain("Sign-in cancelled");
  });
  it("does not label public MCP authentication as OAuth connected", async () => {
    api.list.mockResolvedValue([install]);
    api.servers.mockResolvedValue([server]);
    api.connect.mockResolvedValue("authorization_not_requested");
    await render("installed");
    await click("notes");
    await click("Sign in");
    expect(container.textContent).toContain("No sign-in required");
    expect(container.textContent).not.toContain("Connected");
  });
  it("ignores an obsolete preview after another selection", async () => {
    let finish!: (value: typeof preview) => void;
    api.preview.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    api.preview.mockResolvedValueOnce({
      ...preview,
      pinnedSource: `${source}-tasks@${preview.resolvedSha}`,
    });
    api.catalog.mockResolvedValue({
      entries: [
        entry,
        {
          ...entry,
          id: "tasks",
          name: "tasks",
          source: `${source}-tasks`,
          installedSource: `${source}-tasks`,
        },
      ],
      unavailableRegistries: [],
      skippedEntries: 0,
    });
    await render();
    await click("notes");
    await click("Back");
    await click("tasks");
    await act(async () => finish({ ...preview, name: "obsolete" }));
    expect(container.textContent).not.toContain("obsolete");
    await click("Add plugin");
    expect(api.install.mock.calls[0]?.[0].source).toBe(`${source}-tasks@${preview.resolvedSha}`);
  });
  it("requires confirmation to remove and only shows servers owned by the selected plugin", async () => {
    api.list.mockResolvedValue([install]);
    api.servers.mockResolvedValue([
      server,
      { ...server, id: "unrelated", installId: "other-plugin", name: "Unrelated server" },
    ]);
    await render("installed");
    await click("notes");
    expect(container.textContent).not.toContain("Unrelated server");
    await click("Remove plugin");
    expect(api.remove).not.toHaveBeenCalled();
    await click("Confirm removal");
    expect(api.remove).toHaveBeenCalledWith({ id: install.id });
    expect(container.textContent).toContain("No plugins installed");
  });
  it("prevents duplicate Add actions while an install is pending", async () => {
    let finish!: (value: typeof install) => void;
    api.install.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await click("notes");
    await click("Add plugin");
    expect(button("Adding…").disabled).toBe(true);
    expect(button("Back").disabled).toBe(true);
    await click("Adding…");
    expect(api.install).toHaveBeenCalledTimes(1);
    await act(async () => {
      api.list.mockResolvedValue([install]);
      api.servers.mockResolvedValue([server]);
      finish(install);
    });
    expect(button("Sign in")).toBeTruthy();
  });
  it("preserves a committed install if its connection-status refresh fails", async () => {
    api.install.mockImplementationOnce(async () => {
      api.servers.mockRejectedValueOnce(new Error("Status unavailable"));
      return install;
    });
    await render();
    await click("notes");
    await click("Add plugin");
    expect(button("Remove plugin")).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Could not install plugin");
  });
  it("does not report an install when the digest gate rejects it", async () => {
    api.install.mockRejectedValue(new Error("Plugin content changed; preview and confirm again"));
    await render();
    await click("notes");
    await click("Add plugin");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Plugin content changed",
    );
    expect(button("Add plugin").disabled).toBe(false);
    expect(container.textContent).not.toContain("Sign in");
  });
});
