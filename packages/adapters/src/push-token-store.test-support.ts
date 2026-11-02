import { credentialDigest } from "./credential-digest.js";
import type { PushRecord, PushTokenStore } from "./push-token-store.js";

export class MemoryPushTokenStore implements PushTokenStore {
  private readonly rows = new Map<string, Map<string, PushRecord>>();
  async load(userId: string) {
    return (await this.list(userId))[0];
  }
  async list(userId: string) {
    return [...(this.rows.get(userId)?.values() ?? [])];
  }
  async save(userId: string, token: string, sessionId = "") {
    const rows = this.rows.get(userId) ?? new Map<string, PushRecord>();
    rows.set(sessionId, { token, ...(sessionId ? { sessionId } : {}) });
    this.rows.set(userId, rows);
  }
  async importLegacy(userId: string, token: string, sessionId: string) {
    if (
      (await this.list(userId)).length ||
      [...this.rows.values()].some((rows) => [...rows.values()].some((row) => row.token === token))
    )
      return false;
    await this.save(userId, token, sessionId);
    return true;
  }
  async remove(userId: string, digest?: string) {
    const rows = this.rows.get(userId);
    if (!rows) return;
    for (const [key, row] of rows)
      if (!digest || credentialDigest(row.token) === digest) rows.delete(key);
  }
  async endSession(userId: string, sessionId: string, nextSessionId?: string) {
    const rows = this.rows.get(userId);
    const row = rows?.get(sessionId);
    if (!row || !rows) return;
    rows.delete(sessionId);
    if (nextSessionId) rows.set(nextSessionId, { ...row, sessionId: nextSessionId });
  }
}
