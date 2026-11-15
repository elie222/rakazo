import { describe, expect, it } from "vitest";
import { createRendererMemoryHistory, rendererRoute } from "./renderer-memory.js";

describe("renderer route", () => {
  it.each([
    ["https://app.example.com/app/clx9f2k3m0000abcd?tab=1#x", "/app/:id"],
    ["https://app.example.com/app/artifacts/clx9f2k3m0000abcd", "/app/artifacts/:id"],
    ["https://app.example.com/invite/AbCdEf123", "/invite/:id"],
    ["https://app.example.com/onboarding/connect-model", "/onboarding/connect-model"],
    ["https://app.example.com/", "/"],
    ["file:///Users/someone/setup.html", "file:"],
    ["not a url", "unknown"],
  ])("%s -> %s", (url, route) => {
    expect(rendererRoute(url)).toBe(route);
  });
});

describe("renderer memory history", () => {
  const url = "https://app.example.com/app/clx9f2k3m0000abcd";
  const metric = (memoryMb: number, pid = 10, creationTime = 0) => ({
    pid,
    creationTime,
    memoryMb,
  });

  it("keeps the last ten samples with uptime and route", () => {
    const history = createRendererMemoryHistory();
    for (let i = 1; i <= 12; i++) history.record(1, metric(i * 100 + 0.4));
    expect(history.tags(1, url, 45 * 60_000)).toEqual({
      "renderer.route": "/app/:id",
      "renderer.uptime_min": "45",
      "renderer.memory_mb": "300,400,500,600,700,800,900,1000,1100,1200",
    });
  });

  it("warns once per renderer process when memory is high", () => {
    const history = createRendererMemoryHistory();
    expect(history.record(1, metric(1500))).toBe(false);
    expect(history.record(1, metric(2100))).toBe(true);
    expect(history.record(1, metric(2500))).toBe(false);
    expect(history.record(1, metric(2100, 11))).toBe(true);
    expect(history.tags(1, url, 0)["renderer.memory_mb"]).toBe("2100");
  });

  it("forgets closed renderers and reports only the route without history", () => {
    const history = createRendererMemoryHistory();
    history.record(1, metric(100));
    history.record(2, metric(200, 20));
    history.retain(new Set([2]));
    expect(history.tags(1, url, 0)).toEqual({ "renderer.route": "/app/:id" });
    expect(history.tags(2, url, 0)["renderer.memory_mb"]).toBe("200");
  });

  it("starts over for a replacement process, even one that reuses the PID", () => {
    const history = createRendererMemoryHistory();
    history.record(1, metric(2100));
    expect(history.record(1, metric(2200, 10, 5_000))).toBe(true);
    expect(history.tags(1, url, 5_000)["renderer.memory_mb"]).toBe("2200");
  });

  it("drops a gone or no longer reported renderer's history", () => {
    const history = createRendererMemoryHistory();
    history.record(1, metric(100));
    history.record(2, metric(200, 20));
    history.forget(1);
    expect(history.tags(1, url, 0)).toEqual({ "renderer.route": "/app/:id" });
    history.clear();
    expect(history.tags(2, url, 0)).toEqual({ "renderer.route": "/app/:id" });
  });
});
