const SAMPLES = 10;
const HIGH_MEMORY_MB = 2048;

interface RendererMetric {
  pid: number;
  creationTime: number;
  memoryMb: number;
}

interface RendererHistory {
  pid: number;
  creationTime: number;
  samples: number[];
  warned: boolean;
}

/** Route words survive; any segment that could be an id, token or name becomes `:id`. */
export function rendererRoute(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "unknown";
  }
  // A file URL's path names the local user.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return parsed.protocol;
  return (
    parsed.pathname
      .split("/")
      .map((segment) => (segment === "" || /^[a-z][a-z-]{0,23}$/.test(segment) ? segment : ":id"))
      .join("/")
      .slice(0, 100) || "/"
  );
}

/** Per-webContents memory history, so a crash report shows growth instead of a single moment. */
export function createRendererMemoryHistory() {
  const histories = new Map<number, RendererHistory>();
  return {
    /** Returns true once per renderer process when it first crosses the high-memory mark. */
    record(contentsId: number, metric: RendererMetric): boolean {
      let history = histories.get(contentsId);
      if (!history || history.pid !== metric.pid) {
        history = {
          pid: metric.pid,
          creationTime: metric.creationTime,
          samples: [],
          warned: false,
        };
        histories.set(contentsId, history);
      }
      history.samples.push(Math.round(metric.memoryMb));
      if (history.samples.length > SAMPLES) history.samples.shift();
      if (history.warned || metric.memoryMb < HIGH_MEMORY_MB) return false;
      history.warned = true;
      return true;
    },
    retain(contentsIds: Set<number>): void {
      for (const id of histories.keys()) if (!contentsIds.has(id)) histories.delete(id);
    },
    tags(contentsId: number, url: string, now: number): Record<string, string> {
      const history = histories.get(contentsId);
      const tags: Record<string, string> = { "renderer.route": rendererRoute(url) };
      if (!history) return tags;
      tags["renderer.uptime_min"] = String(
        Math.max(0, Math.round((now - history.creationTime) / 60_000)),
      );
      tags["renderer.memory_mb"] = history.samples.join(",");
      return tags;
    },
  };
}
