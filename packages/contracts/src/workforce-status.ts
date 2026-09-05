export interface WorkforceStatus {
  id: string;
  endpoint: string;
  enabled: boolean;
  companyName: string;
  companySlug: string;
  workers: Array<{ id: string; name: string; model: string; instructions: string }>;
  lastSyncedAt: string | null;
  lastError: string | null;
  assignments: Array<{
    id: string;
    seq: number;
    botId: string;
    runId: string | null;
    synced: boolean;
    status: string;
  }>;
}
