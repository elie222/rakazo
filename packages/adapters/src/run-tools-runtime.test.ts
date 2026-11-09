import type { ConnectorCall, ConnectorTool } from "@rakazo/adapter-kit";
import { expect, it, vi } from "vitest";
import { createApprovedEffectReplayQueue } from "./approval-effect.js";
import { CATALOG_EXECUTE } from "./lazy-tool-catalog.js";
import { executeImageSearch } from "./pi-image-search.js";
import type { RunContext } from "./run-context.js";
import { applyTool } from "./run-tools.js";
import { fixtureFetch, hostFor, terminal } from "./testing/pi-image-search.js";

it.each(["collision", "partial route", "catalog remap", "explicit route"])(
  "refuses runtime image search on a connector %s before gate or execution",
  async (kind) => {
    const fetch = fixtureFetch([terminal]);
    const { host } = hostFor(fetch);
    const run = vi.fn((args: Record<string, unknown>) => executeImageSearch(host, args));
    const execute = vi.fn();
    const effectCreate = vi.fn();
    const connectorTool: ConnectorTool = {
      name: "image_search",
      description: "Colliding connector",
      inputSchema: { type: "object" },
      route:
        kind === "partial route"
          ? { connectorId: "demo", toolName: CATALOG_EXECUTE }
          : { connectorId: "demo", resourceId: "resource-test", toolName: "image_search" },
    };
    const resolveCall = vi.fn(async (call: ConnectorCall) => {
      if (kind !== "catalog remap") return undefined;
      return {
        tool: { ...connectorTool, name: "demo_get_item" },
        call: { ...call, tool: "demo_get_item" },
      };
    });
    const ctx = {
      deps: {
        prisma: { externalEffect: { create: effectCreate } },
        connector: { resolveCall, execute },
      },
      run: { trigger: "user" },
      state: { tainted: false, handedOff: false },
      tools: {
        disabled: new Set<string>(),
        approvedReplays: createApprovedEffectReplayQueue([]),
        connector: new Map(kind === "explicit route" ? [] : [["image_search", connectorTool]]),
      },
      context: { signal: new AbortController().signal },
    } as unknown as RunContext;
    await expect(
      applyTool(
        ctx,
        "image_search",
        { query: "harbor" },
        "image-call",
        kind === "explicit route" ? connectorTool.route : undefined,
        undefined,
        run,
      ),
    ).resolves.toEqual({ error: "image_search is unavailable here." });
    expect(run).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(effectCreate).not.toHaveBeenCalled();
  },
);
