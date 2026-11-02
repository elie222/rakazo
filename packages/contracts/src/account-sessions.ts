/** A notification occurrence owned by one authenticated account. */
export type AccountNotification = {
  id: string;
  kind: "completion" | "failure" | "help" | "takeover";
  title: string;
  body: string;
  botId: string;
  groupId?: string;
  threadId: string;
  spaceId: string;
};

export type SavedAccountSummary = {
  userId: string;
  sessionId: string;
  name: string;
  email: string;
  image: string | null;
  unread: number;
  notifications: AccountNotification[];
};

export type AccountSessions = {
  serverOrigin?: string;
  activeUserId: string | null;
  accounts: SavedAccountSummary[];
};
