import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { type SandboxInput, xdotoolCommand } from "./computer-spec.js";

export const computerActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("key"), key: z.string(), modifiers: z.array(z.string()).optional() }),
  z.object({
    kind: z.literal("pointer"),
    x: z.number(),
    y: z.number(),
    button: z.enum(["left", "right"]).optional(),
    type: z.enum(["move", "down", "up", "click"]),
  }),
  z.object({ kind: z.literal("clipboard"), text: z.string() }),
  z.object({
    kind: z.literal("scroll"),
    direction: z.enum(["up", "down"]),
    amount: z.number().optional(),
  }),
  z.object({ kind: z.literal("wait"), ms: z.number() }),
  z.object({ kind: z.literal("open"), path: z.string() }),
  z.object({ kind: z.literal("launch"), application: z.string(), uri: z.string().optional() }),
]);

export function assertRequestIdentity(
  botId: string | undefined,
  workspaceId: string | undefined,
  expected: { botId: string; workspaceId: string },
) {
  if (botId !== expected.botId || workspaceId !== expected.workspaceId) {
    throw new Error("computer identity mismatch");
  }
}

export function hasValidBearerToken(authorization: string | undefined, expectedToken: string) {
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const actual = Buffer.from(expectedToken);
  const candidate = Buffer.from(supplied);
  return actual.length === candidate.length && timingSafeEqual(actual, candidate);
}

export function toSandboxInput(input: {
  kind: "key" | "pointer" | "clipboard";
  key?: string;
  modifiers?: string[];
  x?: number;
  y?: number;
  button?: "left" | "right";
  type?: "move" | "down" | "up" | "click";
  text?: string;
}): SandboxInput {
  if (input.kind === "key") {
    return { kind: "key", key: input.key ?? "", modifiers: input.modifiers };
  }
  if (input.kind === "clipboard") return { kind: "clipboard", text: input.text ?? "" };
  return {
    kind: "pointer",
    x: input.x ?? 0,
    y: input.y ?? 0,
    button: input.button,
    type: input.type ?? "click",
  };
}

export function containerActionStep(
  action: z.infer<typeof computerActionSchema>,
): { argv: string[] } | { waitMs: number } {
  if (action.kind === "wait") {
    return { waitMs: Math.min(Math.max(action.ms, 0), 5_000) };
  }
  let argv: string[];
  if (action.kind === "key" || action.kind === "pointer" || action.kind === "clipboard") {
    argv = ["env", "DISPLAY=:1", ...xdotoolCommand(toSandboxInput(action))];
  } else if (action.kind === "scroll") {
    argv = [
      "env",
      "DISPLAY=:1",
      "xdotool",
      "click",
      "--repeat",
      String(Math.min(Math.max(Math.round(action.amount ?? 3), 1), 20)),
      action.direction === "up" ? "4" : "5",
    ];
  } else if (action.kind === "open") {
    const target = /^https?:\/\//i.test(action.path)
      ? action.path
      : workspaceTarget(normalizeWorkspaceRelative(action.path));
    argv = ["env", "DISPLAY=:1", "xdg-open", target];
  } else {
    argv = ["env", "DISPLAY=:1", action.application, ...(action.uri ? [action.uri] : [])];
  }
  return { argv };
}

export function normalizeWorkspaceRelative(value: string) {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("path escapes the computer workspace");
  }
  return segments.join("/");
}

export function workspaceTarget(relative: string) {
  return relative ? path.posix.join("/home/rakazo", relative) : "/home/rakazo";
}

export function parseObservation(output: string) {
  const geometry = output.match(/^GEOM\s+(\d+)\s+(\d+)$/m);
  const cursorLine = output.match(/^CURSOR\s+(.+)$/m)?.[1] ?? "";
  const cursorX = Number(cursorLine.match(/X=(\d+)/)?.[1]);
  const cursorY = Number(cursorLine.match(/Y=(\d+)/)?.[1]);
  const windowId = output.match(/^WINDOW\s*(.*)$/m)?.[1]?.trim();
  const title = output.match(/^TITLE\s*(.*)$/m)?.[1]?.trim();
  const image = output.match(/^IMAGE\s+([A-Za-z0-9+/=]+)$/m)?.[1];
  if (!image) throw new Error("screen capture returned no image");
  return {
    image,
    mimeType: "image/png" as const,
    width: Number(geometry?.[1] ?? 1280),
    height: Number(geometry?.[2] ?? 800),
    ...(Number.isFinite(cursorX) && Number.isFinite(cursorY)
      ? { cursor: { x: cursorX, y: cursorY } }
      : {}),
    ...(windowId ? { activeWindow: { id: windowId, ...(title ? { title } : {}) } } : {}),
  };
}
