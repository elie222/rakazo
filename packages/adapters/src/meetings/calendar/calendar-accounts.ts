import type { MeetingCalendarAccountStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { EncryptedSecretStore } from "../../secrets/secrets.js";

export interface MeetingCalendarAccountVault extends MeetingCalendarAccountStore {
  seal(
    connectionId: string,
    plaintext: string,
    owner: { spaceId: string; userId: string },
  ): Promise<string>;
}

function recordId(connectionId: string) {
  return `meeting-calendar:${connectionId}`;
}

/** Calendar account details sealed with the deployment key on their connection row. */
export class PrismaMeetingCalendarAccounts implements MeetingCalendarAccountVault {
  private readonly encryption: EncryptedSecretStore;

  constructor(
    private readonly prisma: PrismaClient,
    encryptionKey: string,
  ) {
    this.encryption = new EncryptedSecretStore(encryptionKey);
  }

  async seal(connectionId: string, plaintext: string, owner: { spaceId: string; userId: string }) {
    const sealed = await this.encryption.put(
      plaintext,
      {
        operationId: "meeting-calendar.connect",
        traceId: "meeting-calendar.connect",
        ...owner,
        signal: new AbortController().signal,
      },
      { recordId: recordId(connectionId) },
    );
    return sealed.ciphertext;
  }

  async load(calendarId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const row = await runAsSystem("read a connected calendar's sealed account", () =>
      this.prisma.meetingCalendarConnection.findFirst({
        where: { externalCalendarId: calendarId, disconnecting: false },
        select: { id: true, accountCiphertext: true },
      }),
    );
    if (!row?.accountCiphertext) return null;
    return this.encryption.load(row.accountCiphertext, { recordId: recordId(row.id), signal });
  }
}
