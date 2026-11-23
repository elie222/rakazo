import { credentialDigest } from "../secrets/credential-digest.js";
import type { PushRecord, PushTokenStore } from "./push-token-store.js";

type Row = PushRecord & { userId: string };

export class MemoryPushTokenStore implements PushTokenStore {
  private rows: Row[] = [];
  async list(userId: string) {
    return this.rows
      .filter((row) => row.userId === userId)
      .map(({ userId: _, ...record }) => record);
  }
  async save(userId: string, token: string, sessionId = "", presentation?: "android_sender") {
    this.rows = this.rows.filter(
      (row) =>
        row.token !== token && !(sessionId && row.userId === userId && row.sessionId === sessionId),
    );
    this.rows.push({
      userId,
      token,
      ...(sessionId ? { sessionId } : {}),
      ...(presentation ? { presentation } : {}),
    });
  }
  async importLegacy(userId: string, token: string, sessionId: string) {
    if (this.rows.some((row) => row.userId === userId || row.token === token)) return false;
    await this.save(userId, token, sessionId);
    return true;
  }
  async remove(userId: string, digest?: string) {
    this.rows = this.rows.filter(
      (row) =>
        row.userId !== userId || (digest !== undefined && credentialDigest(row.token) !== digest),
    );
  }
  async endSession(userId: string, sessionId: string, nextSessionId?: string) {
    this.rows = this.rows.flatMap((row) => {
      if (row.userId !== userId || row.sessionId !== sessionId) return [row];
      return nextSessionId ? [{ ...row, sessionId: nextSessionId }] : [];
    });
  }
}
