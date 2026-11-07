import { credentialDigest } from "./credential-digest.js";
import type { DesktopPushTarget, PushRecord, PushTokenStore } from "./push-token-store.js";

export class MemoryPushTokenStore implements PushTokenStore {
  private readonly rows = new Map<string, PushRecord>();
  readonly desktop = new Map<
    string,
    { userId: string; token: string; sessionId: string; live?: { spaceId: string; until: Date } }
  >();
  async saveDesktop(userId: string, token: string, sessionId: string) {
    this.desktop.set(credentialDigest(token), { userId, token, sessionId });
  }
  async desktopTargets(userId: string, spaceId: string): Promise<DesktopPushTarget[]> {
    return [...this.desktop.entries()]
      .filter(
        ([, row]) =>
          row.userId === userId &&
          !(row.live?.spaceId === spaceId && row.live.until.getTime() > Date.now()),
      )
      .map(([id, row]) => ({ id, token: row.token }));
  }
  async hasDesktopTarget(userId: string, spaceId: string) {
    return (await this.desktopTargets(userId, spaceId)).length > 0;
  }
  async removeDesktop(userId: string, id: string) {
    if (this.desktop.get(id)?.userId === userId) this.desktop.delete(id);
  }
  async markDesktopLive(
    userId: string,
    sessionId: string,
    live: { spaceId: string; until: Date } | null,
    written?: Date,
  ) {
    for (const row of this.desktop.values())
      if (
        row.userId === userId &&
        row.sessionId === sessionId &&
        (!written || row.live?.until.getTime() === written.getTime())
      )
        row.live = live ?? undefined;
  }
  async load(userId: string) {
    return this.rows.get(userId);
  }
  async save(userId: string, token: string, sessionId = "", presentation?: "android_sender") {
    for (const [owner, row] of this.rows) if (row.token === token) this.rows.delete(owner);
    this.rows.set(userId, {
      token,
      ...(sessionId ? { sessionId } : {}),
      ...(presentation ? { presentation } : {}),
    });
  }
  async importLegacy(userId: string, token: string, sessionId: string) {
    if (this.rows.has(userId) || [...this.rows.values()].some((row) => row.token === token))
      return false;
    await this.save(userId, token, sessionId);
    return true;
  }
  async remove(userId: string, digest?: string) {
    const row = this.rows.get(userId);
    if (row && (!digest || credentialDigest(row.token) === digest)) this.rows.delete(userId);
  }
  async endSession(userId: string, sessionId: string, nextSessionId?: string) {
    const row = this.rows.get(userId);
    if (row?.sessionId !== sessionId) return;
    if (nextSessionId) this.rows.set(userId, { ...row, sessionId: nextSessionId });
    else this.rows.delete(userId);
  }
}
