import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  NotificationMessage,
  NotificationProvider,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";

export function pushTokenPath(dataDir: string, userId: string) {
  return path.join(dataDir, "push-tokens", `${userId}.txt`);
}

export async function loadPushToken(dataDir: string, userId: string): Promise<string | undefined> {
  try {
    const token = (await readFile(pushTokenPath(dataDir, userId), "utf8")).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export async function savePushToken(dataDir: string, userId: string, token: string): Promise<void> {
  await mkdir(path.dirname(pushTokenPath(dataDir, userId)), { recursive: true });
  await writeFile(pushTokenPath(dataDir, userId), token.trim(), "utf8");
}

export async function deletePushToken(dataDir: string, userId: string): Promise<void> {
  await unlink(pushTokenPath(dataDir, userId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export type ExpoPushTicket = {
  status?: string;
  message?: string;
  details?: { error?: string };
};

export function expoPushTickets(body: unknown): ExpoPushTicket[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: unknown }).data;
  if (Array.isArray(data)) {
    return data.filter((item): item is ExpoPushTicket => Boolean(item) && typeof item === "object");
  }
  if (data && typeof data === "object") return [data as ExpoPushTicket];
  return [];
}

export function expoPushErrorMessage(body: unknown, status: number): string | undefined {
  if (body && typeof body === "object" && "errors" in body) {
    const errors = (body as { errors?: Array<{ message?: string }> }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      return errors.map((error) => error.message ?? "expo push error").join("; ");
    }
  }
  const failed = expoPushTickets(body).filter((ticket) => ticket.status === "error");
  if (failed.length > 0) {
    return failed
      .map((ticket) => ticket.message ?? ticket.details?.error ?? "expo push ticket error")
      .join("; ");
  }
  if (status < 200 || status >= 300) return `expo push failed (${status})`;
  return undefined;
}

export class ExpoPushProvider implements NotificationProvider {
  constructor(private readonly dataDir: string) {}

  describe() {
    return {
      id: "expo-push",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { push: true, email: false },
    };
  }

  async send(message: NotificationMessage, context: AdapterContext): Promise<void> {
    const token = await loadPushToken(this.dataDir, context.userId);
    if (!token) return;
    let response: Response;
    try {
      response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          to: token,
          title: message.title,
          body: message.body,
          collapseId: message.threadId,
          tag: message.threadId,
          data: { kind: message.kind, botId: message.botId, threadId: message.threadId },
        }),
      });
    } catch (error) {
      getLogger().error("expo push request failed", error);
      throw error;
    }
    const body = await response.json().catch(() => undefined);
    const failure = expoPushErrorMessage(body, response.status);
    if (!failure) return;
    getLogger().error(failure);
    throw new Error(failure);
  }
}
