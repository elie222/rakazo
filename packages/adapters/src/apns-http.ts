import { createPrivateKey, sign } from "node:crypto";
import { connect } from "node:http2";

/** Signing key and target of one app's APNs pushes. */
export type ApnsConfig = {
  keyId: string;
  teamId: string;
  privateKey: string;
  environment: "sandbox" | "production";
  bundleId: string;
};

export type ApnsTransport = (
  origin: string,
  headers: Record<string, string>,
  body: string,
) => Promise<{ status: number; reason?: string }>;

/** HTTP/2 stays in this adapter; tests inject a transport and never contact Apple. */
export const apnsTransport: ApnsTransport = (origin, headers, body) =>
  new Promise((resolve, reject) => {
    const client = connect(origin);
    const finish = () => client.close();
    client.setTimeout(10_000, () => client.destroy(new Error("APNs connection timed out")));
    client.on("error", () => {
      finish();
      reject(new Error("APNs connection failed"));
    });
    const request = client.request(headers);
    let status = 0;
    let data = "";
    request.setTimeout(10_000, () => request.destroy(new Error("APNs request timed out")));
    request.on("response", (reply) => {
      status = Number(reply[":status"]);
    });
    request.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 4096) request.destroy(new Error("APNs response too large"));
    });
    request.on("error", () => {
      finish();
      reject(new Error("APNs request failed"));
    });
    request.on("end", () => {
      finish();
      let reason: string | undefined;
      try {
        reason = (JSON.parse(data) as { reason?: string }).reason;
      } catch {
        /* Empty success response. */
      }
      resolve({ status, reason });
    });
    request.end(body);
  });

export function apnsOrigin(environment: ApnsConfig["environment"]): string {
  return environment === "sandbox"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";
}

/** Provider token for APNs: an ES256 JWT, reused for 50 minutes of its hour. */
export class ApnsAuthorization {
  private readonly key;
  private jwt?: { value: string; issuedAt: number };
  constructor(private readonly config: Pick<ApnsConfig, "keyId" | "teamId" | "privateKey">) {
    this.key = createPrivateKey(config.privateKey);
  }
  header(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt && now >= this.jwt.issuedAt && now - this.jwt.issuedAt < 50 * 60)
      return this.jwt.value;
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: this.config.keyId })).toString(
      "base64url",
    );
    const claims = Buffer.from(JSON.stringify({ iss: this.config.teamId, iat: now })).toString(
      "base64url",
    );
    const unsigned = `${header}.${claims}`;
    const signature = sign("sha256", Buffer.from(unsigned), {
      key: this.key,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    const value = `bearer ${unsigned}.${signature}`;
    this.jwt = { value, issuedAt: now };
    return value;
  }
}
