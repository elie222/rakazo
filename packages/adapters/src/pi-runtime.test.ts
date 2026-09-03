import { describe, expect, it } from "vitest";
import { describeToolActivity } from "./pi-runtime.js";

describe("describeToolActivity", () => {
  it("summarizes builtin tools with their most informative argument", () => {
    expect(describeToolActivity("shell", { command: "pnpm test --filter web" })).toBe(
      "Running: pnpm test --filter web",
    );
    expect(describeToolActivity("read_file", { path: "notes/plan.md" })).toBe(
      "Reading notes/plan.md",
    );
    expect(describeToolActivity("write_file", { path: "out.csv", content: "…" })).toBe(
      "Writing out.csv",
    );
    expect(describeToolActivity("render_plot", { spec: {} })).toBe("Rendering a chart");
    expect(describeToolActivity("add_mcp_server", { name: "Linear" })).toBe(
      "Connecting MCP server: Linear",
    );
    expect(describeToolActivity("run_subagent", { name: "scout", task: "…" })).toBe(
      "Delegating to helper: scout",
    );
    expect(describeToolActivity("create_space", { name: "Customer support" })).toBe(
      "Creating space: Customer support",
    );
    expect(describeToolActivity("web_search", { query: "rakazo agents" })).toBe(
      "Searching the web: rakazo agents",
    );
    expect(describeToolActivity("web_fetch", { url: "https://example.com" })).toBe(
      "Reading page: https://example.com/",
    );
  });

  it("names MCP server and remote tool", () => {
    expect(describeToolActivity("mcp__brex__list_expenses", {})).toBe("Using brex: list_expenses");
    expect(describeToolActivity("mcp__demo-oauth__greet", {})).toBe("Using demo-oauth: greet");
  });

  it("truncates long details and collapses whitespace", () => {
    const long = `x${"y".repeat(200)}`;
    const line = describeToolActivity("shell", { command: `a\n\t${long}` });
    expect(line.length).toBeLessThanOrEqual("Running: ".length + 91);
    expect(line).toContain("…");
    expect(line).not.toContain("\n");
    expect(line).toMatch(/^Running: a x/);
  });

  it("redacts credentials from activity details", () => {
    const token = "fake-token";
    const line = describeToolActivity("shell", {
      command: `curl -H 'Authorization: Bearer ${token}' https://example.test?api_key=fake-key password=fake-password`,
    });

    expect(line).toContain("Bearer [redacted]");
    expect(line).toContain("api_key=[redacted]");
    expect(line).not.toContain(token);
    expect(line).not.toContain("fake-key");
    expect(line).not.toContain("fake-password");
  });

  it("strips signed-URL query and fragment from web_fetch activity", () => {
    const line = describeToolActivity("web_fetch", {
      url: "https://user:secret@cdn.example.test/doc.pdf?X-Amz-Signature=abc123&token=leak#frag",
    });
    expect(line).toBe("Reading page: https://cdn.example.test/doc.pdf");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("X-Amz-Signature");
    expect(line).not.toContain("token=");
    expect(line).not.toContain("abc123");
    expect(line).not.toContain("frag");
  });

  it("does not echo secrets from malformed web_fetch URLs", () => {
    const line = describeToolActivity("web_fetch", {
      url: "https://user:secret@[",
    });
    expect(line).toBe("Reading page: [invalid URL]");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("user:");
  });

  it("falls back to the tool name", () => {
    expect(describeToolActivity("destination_write", undefined)).toBe("Using destination_write");
  });
});
