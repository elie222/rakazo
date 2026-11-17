import { credentialDigest } from "../shared/credential-digest.js";
import type { DesktopPushTarget, PushRecord, PushTokenStore } from "./push-token-store.js";

type Row = PushRecord & { userId: string };

export class MemoryPushTokenStore implements PushTokenStore {
  private rows: Row[] = [];
  readonly desktop = new Map<
    string,
    { userId: string; token: string; sessionId: string; live?: { spaceId: string; until: Date } }
  >();
  async saveDesktop(userId: string, token: string, sessionId: string) {
    this.desktop.set(credentialDigest(token), { userId, token, sessionId });
    return true;
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
