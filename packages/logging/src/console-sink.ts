import type { LogEvent, LogFormat, LogSink } from "./types.js";

const SKIP_PRETTY = new Set(["timestamp", "level", "message"]);

export function createConsoleSink(options: { format?: LogFormat } = {}): LogSink {
  const format = options.format ?? "json";
  return {
    write(event) {
      emit(event, format);
    },
  };
}

function emit(event: LogEvent, format: LogFormat): void {
  const line = format === "pretty" ? formatPretty(event) : JSON.stringify(event);
  if (event.level === "error") console.error(line);
  else if (event.level === "warn") console.warn(line);
  else console.info(line);
}

function formatPretty(event: LogEvent): string {
  const time = event.timestamp.slice(11, 23) || event.timestamp;
  const fields: string[] = [];
  for (const [key, value] of Object.entries(event)) {
    if (SKIP_PRETTY.has(key) || value === undefined) continue;
    fields.push(`${key}=${formatField(value)}`);
  }
  const suffix = fields.length > 0 ? ` ${fields.join(" ")}` : "";
  return `${time} ${event.level.toUpperCase().padEnd(5)} ${event.message}${suffix}`;
}

function formatField(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Error) return value.message;
  try {
    const json = JSON.stringify(value);
    return json && json.length > 200 ? `${json.slice(0, 197)}...` : (json ?? "");
  } catch {
    return "[unserializable]";
  }
}
