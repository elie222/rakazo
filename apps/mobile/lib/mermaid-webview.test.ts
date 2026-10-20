import { chatMermaidConfig } from "@rakazo/chat-ui/mermaid";
import { darkTokens } from "@rakazo/ui-tokens";
import { describe, expect, it, vi } from "vitest";
import {
  diagramBootScript,
  diagramDocument,
  diagramScriptUrl,
  MAX_DIAGRAM_HEIGHT,
  parseDiagramMessage,
} from "./mermaid-webview";

const config = chatMermaidConfig(darkTokens, "dark", { surface: darkTokens.background });

function policyOf(html: string) {
  const content = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
  return content
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<");
}

describe("diagram WebView document", () => {
  it("loads Mermaid from the server the app talks to", () => {
    expect(diagramScriptUrl("https://rakazo.example.test")).toBe(
      "https://rakazo.example.test/api/v1/assets/mermaid.js",
    );
    expect(diagramScriptUrl("http://192.168.1.20:5173")).toBe(
      "http://192.168.1.20:5173/api/v1/assets/mermaid.js",
    );
  });

  it("allows that one script and nothing that reaches the network", () => {
    const url = diagramScriptUrl("https://rakazo.example.test");
    const html = diagramDocument(url);
    const policy = policyOf(html).split("; ");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain(`script-src ${url}`);
    expect(policy).toContain("img-src data:");
    expect(policy.filter((directive) => directive.startsWith("script-src"))).toEqual([
      `script-src ${url}`,
    ]);
    expect(policy.some((directive) => directive.includes("unsafe-eval"))).toBe(false);
    expect(policy.some((directive) => directive.startsWith("connect-src"))).toBe(false);
    expect(html).toContain(`<script src="${url}"></script>`);
    // The only script element is Mermaid; the drawing code is injected natively.
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it("escapes the script URL inside attributes", () => {
    const html = diagramDocument('https://x.test/a"b<c');
    expect(html).toContain('src="https://x.test/a&quot;b&lt;c"');
  });
});

describe("diagram boot script", () => {
  async function run(source: string, mermaid: unknown) {
    const posted: unknown[] = [];
    const svg = { viewBox: { baseVal: { width: 744 } }, style: { minWidth: "" } };
    const root = {
      innerHTML: "",
      getBoundingClientRect: () => ({ height: 87.2 }),
      querySelector: () => svg,
    };
    const window = {
      mermaid,
      ReactNativeWebView: { postMessage: (data: string) => posted.push(JSON.parse(data)) },
    };
    const document = { getElementById: () => root };
    new Function("window", "document", diagramBootScript(source, config))(window, document);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { posted, root, svg };
  }

  it("draws the source with the chat config and reports the height", async () => {
    const mermaid = {
      initialize: vi.fn(),
      parse: vi.fn(async () => true),
      render: vi.fn(async () => ({ svg: "<svg></svg>" })),
    };
    const source = 'graph LR\n  A["quote \\" and </script>"] --> B';
    const { posted, root, svg } = await run(source, mermaid);
    expect(mermaid.initialize).toHaveBeenCalledWith(config);
    expect(mermaid.parse).toHaveBeenCalledWith(source, { suppressErrors: true });
    expect(mermaid.render).toHaveBeenCalledWith("rk-mermaid", source);
    expect(root.innerHTML).toBe("<svg></svg>");
    // A wide diagram keeps at least 80% of its size and scrolls instead.
    expect(svg.style.minWidth).toBe("596px");
    expect(posted).toEqual([{ type: "drawn", height: 88 }]);
  });

  it("embeds hostile source only as a JSON string in the native boot script", async () => {
    const source = "</script><script>alert(1)</script>\u2028\u2029";
    const boot = diagramBootScript(source, config);
    expect(boot).toContain(`var source = ${JSON.stringify(source)};`);
    expect(diagramDocument(diagramScriptUrl("https://rakazo.example.test"))).not.toContain(source);
    const mermaid = {
      initialize: vi.fn(),
      parse: vi.fn(async () => true),
      render: vi.fn(async () => ({ svg: "<svg/>" })),
    };
    await run(source, mermaid);
    expect(mermaid.parse).toHaveBeenCalledWith(source, { suppressErrors: true });
    expect(mermaid.render).toHaveBeenCalledWith("rk-mermaid", source);
  });

  it("reports failure when Mermaid did not load, cannot parse, or throws", async () => {
    expect((await run("graph LR", undefined)).posted).toEqual([{ type: "failed" }]);
    const invalid = { initialize: vi.fn(), parse: vi.fn(async () => false), render: vi.fn() };
    expect((await run("nope", invalid)).posted).toEqual([{ type: "failed" }]);
    expect(invalid.render).not.toHaveBeenCalled();
    const throwing = {
      initialize: vi.fn(),
      parse: vi.fn(async () => true),
      render: vi.fn(async () => Promise.reject(new Error("layout"))),
    };
    expect((await run("graph LR", throwing)).posted).toEqual([{ type: "failed" }]);
  });
});

describe("parseDiagramMessage", () => {
  it("accepts the two messages the page sends", () => {
    expect(parseDiagramMessage('{"type":"drawn","height":120}')).toEqual({
      type: "drawn",
      height: 120,
    });
    expect(parseDiagramMessage('{"type":"failed"}')).toEqual({ type: "failed" });
  });

  it("accepts the maximum height", () => {
    expect(
      parseDiagramMessage(JSON.stringify({ type: "drawn", height: MAX_DIAGRAM_HEIGHT })),
    ).toEqual({
      type: "drawn",
      height: MAX_DIAGRAM_HEIGHT,
    });
  });

  it("fails when the height exceeds the maximum", () => {
    for (const height of [MAX_DIAGRAM_HEIGHT + 1, 1e100]) {
      expect(parseDiagramMessage(JSON.stringify({ type: "drawn", height }))).toEqual({
        type: "failed",
      });
    }
  });

  it("ignores anything else", () => {
    for (const data of [
      "null",
      "[]",
      "42",
      '{"type":"drawn","height":-1}',
      '{"type":"drawn","height":1e999}',
    ]) {
      expect(parseDiagramMessage(data)).toBeNull();
    }
    expect(parseDiagramMessage("not json")).toBeNull();
    expect(parseDiagramMessage('{"type":"drawn","height":0}')).toBeNull();
    expect(parseDiagramMessage('{"type":"drawn","height":"12"}')).toBeNull();
    expect(parseDiagramMessage('{"type":"navigate","url":"https://x.test"}')).toBeNull();
  });
});
