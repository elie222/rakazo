export type ConnectionAccountStatus = "pending" | "connected" | "revoked" | "error";

export function splitConnectionAccounts<T extends { status: ConnectionAccountStatus }>(
  connections: T[],
) {
  return {
    active: connections.filter((connection) => connection.status === "connected"),
    pending: connections.filter((connection) => connection.status === "pending"),
  };
}
